import { NETWORKS } from "@auni/shared";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRow } from "../../db/schema.ts";
import { figureOf } from "../../test/recipe.ts";
import { solanaRpc, solanaTokenBalance } from "../chains.ts";
import { WRAPPED_SOL } from "../fill-key.ts";
import { approval, effectLines, pinnedApproval } from "../effect.ts";
import { feeCoinsSaid } from "../fee-coin-said.ts";
import type { Signer } from "../recipe.ts";
import { simulateSolana } from "../solana-effect.ts";
import { sendSolanaTransaction } from "./solana.ts";

// Solana's RPC and Jupiter are stood in; unpacking, the effect, the rules and the card are real.
vi.mock("../chains.ts", async (original) => ({
  ...(await original()),
  solanaRpc: vi.fn(),
  solanaTokenBalance: vi.fn(async () => 50_000_000n),
}));
vi.mock("@solana/kit", async (original) => ({
  ...(await original()),
  createSolanaRpc: () => ({
    getLatestBlockhash: () => ({
      send: async () => ({ value: { blockhash: FRESH, lastValidBlockHeight: 9n } }),
    }),
  }),
}));
vi.mock("../swaps/solana-swap.ts", async (original) => ({
  ...(await original()),
  solanaTokens: async () => [
    { mint: NETWORKS.solana.usdc, symbol: "USDC", name: "USD Coin", decimals: 6, verified: true },
    { mint: BONK, symbol: "Bonk", name: "Bonk", decimals: 5, verified: true },
    { mint: WRAPPED_SOL, symbol: "SOL", name: "Wrapped SOL", decimals: 9, verified: true },
    { mint: FAKE, symbol: "FAKE", name: "Fake", decimals: 6, verified: false },
  ],
  solanaPrice: async (mint: string) => ({
    usdPrice: { [NETWORKS.solana.usdc]: 1, [BONK]: 0.05, [WRAPPED_SOL]: 100 }[mint] ?? 1,
    multiplier: 1,
  }),
}));
// SOL at $100, as DefiLlama would price it.
vi.mock(import("../token-feeds.ts"), async (original) => ({
  ...(await original()),
  solUsd: async () => 100,
}));
// Buying SOL sends Jupiter's swap as setup; its own simulation is checked in sol-top-up.test.ts.
vi.mock("../sol-top-up.ts", async (original) => ({
  ...(await original()),
  topUpSol: async (wallets: Signer) => [
    {
      chain: "solana",
      hash: await wallets.sendSolanaTransaction("top-up", { setup: true }),
      setup: true,
    },
  ],
}));
// A wallet with a sponsor, which buys SOL with its Solana USDC; one with none buys it on
// Monad through Relay, checked in sol-top-up.test.ts.
const sponsor = vi.hoisted(() => ({ paysSolana: false }));
vi.mock("../wallets.ts", async (original) => ({
  ...(await original()),
  solanaAddress: async () => OWNER,
  walletAddresses: async () => ({ evm: null, solana: OWNER }),
  paysOwnGas: async () => sponsor.paysSolana,
}));
vi.mock("../app-logo.ts", () => ({ appLogo: async () => null }));

const OWNER = address("JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n");
const APP = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const USDC_ACCOUNT = address("6Fnf9PuEXNhbZbrmUxPirWHRQWt4VpxVbXywqM3xhFgg");
const BONK_ACCOUNT = address("FzbcyEZ9m8xjtergWgWDq7mfPoHEbboBF791B6cTpzbq");
const POOL = address("GZuFT72jZWfuZk4YC6diVDWJ4LZGQNQnrUNLbsYjFo5i");
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const FAKE = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const STAKE = "Stake11111111111111111111111111111111111111";
const LENDING = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const FRESH = "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM";
const RENT = 1_488_440;

/** One call to the app's program from the wallet, which signs with whoever else is named. */
function transaction(...signers: string[]) {
  const accounts = [OWNER, ...signers.map(address)].map((each) => ({
    address: each,
    role: AccountRole.WRITABLE_SIGNER,
  }));
  const others = [USDC_ACCOUNT, BONK_ACCOUNT, POOL].map((each) => ({
    address: each,
    role: AccountRole.WRITABLE,
  }));
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(OWNER, draft),
    (draft) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n },
        draft,
      ),
    (draft) =>
      appendTransactionMessageInstruction(
        { programAddress: APP, accounts: [...accounts, ...others] },
        draft,
      ),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

/** What the chain says around the transaction, by address; the stand-in RPC lays it out. */
interface Scene {
  readonly err?: unknown;
  readonly fee?: number;
  readonly lamports: Record<string, readonly [number, number]>;
  readonly tokens: readonly {
    readonly account: string;
    readonly mint: string;
    readonly decimals: number;
    readonly pre?: readonly [owner: string, amount: number];
    readonly post?: readonly [owner: string, amount: number];
  }[];
  /** After the transaction, as the simulation reads them. */
  readonly accounts?: Record<string, unknown>;
  /** Programs it calls from other programs. */
  readonly inner?: readonly string[];
  /** Before it, the program owning each account and the account's bytes. */
  readonly before?: Record<string, readonly [owner: string, data: Uint8Array]>;
}

/** Sends 5 USDC and gets 100 BONK into a token account it opens. */
const swap = (sol = 10_000_000): Scene => ({
  lamports: {
    [OWNER]: [sol, sol - 5_000 - RENT],
    [USDC_ACCOUNT]: [RENT, RENT],
    [BONK_ACCOUNT]: [0, RENT],
  },
  tokens: [
    {
      account: USDC_ACCOUNT,
      mint: NETWORKS.solana.usdc,
      decimals: 6,
      pre: [OWNER, 5_000_000],
      post: [OWNER, 0],
    },
    { account: BONK_ACCOUNT, mint: BONK, decimals: 5, post: [OWNER, 10_000_000] },
  ],
});

/** The same, from a wallet with no SOL: it fails, and lent SOL it goes through. */
const shortSwap = (lent: boolean): Scene =>
  lent
    ? {
        ...swap(0),
        fee: 10_000,
        lamports: { ...swap(0).lamports, [OWNER]: [0, 1_000_000_000 - RENT] },
      }
    : { err: "InsufficientFundsForFee", lamports: {}, tokens: [] };

/** The wallet's USDC account, left with a delegate that can spend from it. */
const delegated: Partial<Scene> = {
  accounts: {
    [USDC_ACCOUNT]: {
      owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      space: 165,
      data: {
        parsed: {
          type: "account",
          info: {
            mint: NETWORKS.solana.usdc,
            owner: OWNER,
            delegate: POOL,
            delegatedAmount: { amount: "1" },
          },
        },
      },
    },
  },
};

let scene: (lent: boolean) => Scene = () => swap();
let landed: unknown = null;

beforeEach(() => {
  vi.mocked(solanaTokenBalance).mockResolvedValue(50_000_000n);
  vi.mocked(solanaRpc).mockImplementation((async (method: string, params: unknown[]) => {
    if (method === "getTransaction") return landed;
    if (method === "getMultipleAccounts") {
      const [addresses] = params as [string[]];
      const before = scene(false).before ?? {};
      return {
        value: addresses.map((each) => {
          const held = before[each];
          return held
            ? { owner: held[0], data: [Buffer.from(held[1]).toString("base64"), "base64"] }
            : null;
        }),
      };
    }
    const [wire, { accounts }] = params as [string, { accounts: { addresses: string[] } }];
    const { messageBytes } = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
    const keys = getCompiledTransactionMessageDecoder().decode(messageBytes).staticAccounts;
    const lent = keys[0] !== OWNER;
    const now = scene(lent);
    const side = (at: 0 | 1) => keys.map((key) => now.lamports[key]?.[at] ?? 0);
    const tokens = (at: "pre" | "post") =>
      now.tokens.flatMap((each) => {
        const held = each[at];
        return held
          ? [
              {
                accountIndex: keys.indexOf(address(each.account)),
                mint: each.mint,
                owner: held[0],
                uiTokenAmount: { amount: String(held[1]), decimals: each.decimals },
              },
            ]
          : [];
      });
    const value = {
      err: now.err ?? null,
      logs: now.err ? ["Program log: Error: not enough SOL"] : [],
      fee: now.fee ?? 5_000,
      preBalances: side(0),
      postBalances: side(1),
      preTokenBalances: tokens("pre"),
      postTokenBalances: tokens("post"),
      innerInstructions: now.inner
        ? [{ index: 0, instructions: now.inner.map((programId) => ({ programId })) }]
        : null,
      loadedAddresses: { writable: [], readonly: [] },
      accounts: accounts.addresses.map(
        (each) =>
          now.accounts?.[each] ??
          (each === OWNER
            ? { owner: "11111111111111111111111111111111", space: 0, data: {} }
            : null),
      ),
    };
    if (!lent) {
      const { preBalances, postBalances, preTokenBalances, postTokenBalances, fee } = value;
      const meta = { preBalances, postBalances, preTokenBalances, postTokenBalances, fee };
      landed = {
        transaction: { message: { accountKeys: keys.map((pubkey) => ({ pubkey })) } },
        meta,
      };
    }
    return { value };
  }) as typeof solanaRpc);
});

const describeIt = (
  tx = transaction(),
  app?: { name: string; site: string; verb: string; note?: string },
) =>
  sendSolanaTransaction.describe(
    { transaction: tx, summary: "Buy Bonk", ...(app ? { app } : {}) },
    {},
  );

describe("send_solana_transaction", () => {
  it("lets a swap go on a tap, with the network fee and rent the wallet pays last", async () => {
    scene = () => swap();
    const card = await describeIt(transaction(), {
      name: "Jupiter",
      site: "jup.ag",
      verb: "swap",
    });
    const { effect, details } = card;
    expect(effectLines(effect)).toEqual([
      { label: "You give", value: "5 USDC ($5)" },
      { label: "You get", value: "100 Bonk ($5)" },
      { label: "Costs", value: "$0.15 network fee" },
    ]);
    expect(approval(effect, [])).toEqual({ kind: "tap" });
    expect(details).toMatchObject({
      network: "Solana",
      chain: "solana",
      mint: BONK,
    });
    expect(card.card).toMatchObject({
      title: "Buy Bonk",
      context: "Jupiter on Solana",
      finePrint: "It goes through JUP6Lk…TaV4.",
    });
    expect(figureOf(card, "Network fee")).toBe("$0.15");
  });

  it("sets the agent's own sentence apart on a tap, and carries none on a card that takes the owner's proof", async () => {
    const app = {
      name: "Kamino",
      site: "kamino.finance",
      verb: "swap",
      note: "It earns 6% a year.",
    };
    scene = () => swap();
    const tapped = await describeIt(transaction(), app);
    expect(approval(tapped.effect, [])).toEqual({ kind: "tap" });
    expect(tapped.card?.checks).toEqual({
      checked: "Checked by running it first",
      unchecked: { heading: "Not checked: what Auni says about it", says: "It earns 6% a year." },
      why: "No app for Kamino yet, so Auni read this by running it first.",
    });
    scene = () => ({ ...swap(), ...delegated });
    const proved = await describeIt(transaction(), app);
    expect(approval(proved.effect, [])).toMatchObject({ kind: "proof" });
    expect(proved.card?.checks?.unchecked).toBeNull();
    expect(JSON.stringify(proved)).not.toContain("It earns 6%");
  });

  it("refuses a transaction someone else must sign", async () => {
    await expect(describeIt(transaction(POOL))).rejects.toThrow(
      "It needs GZuFT7…Fo5i to sign as well as the wallet",
    );
  });

  it("refuses one that fails in the simulation, saying why", async () => {
    scene = () => ({ err: { InstructionError: [0, { Custom: 1 }] }, lamports: {}, tokens: [] });
    await expect(describeIt()).rejects.toThrow(
      'It fails in a simulation ({"InstructionError":[0,{"Custom":1}]}: Program log: Error: not enough SOL)',
    );
  });

  it("refuses one that hands the wallet itself to a program", async () => {
    scene = () => ({ ...swap(), accounts: { [OWNER]: { owner: APP, space: 0, data: {} } } });
    await expect(describeIt()).rejects.toThrow("hands the wallet itself to a program");
  });

  it("says a permission it leaves as what it lets, after what it costs", async () => {
    scene = () => ({ ...swap(), ...delegated });
    expect(effectLines((await describeIt()).effect)).toContainEqual({
      label: "Lets",
      value: "GZuFT72jZWfuZk4YC6diVDWJ4LZGQNQnrUNLbsYjFo5i spend your USDC",
    });
  });

  // Anyone can mint a token for nothing, so one Jupiter doesn't verify vouches for nothing sent.
  it("takes the code for a trade for a token Jupiter doesn't verify", async () => {
    scene = () => ({
      ...swap(),
      tokens: [
        swap().tokens[0]!,
        { account: BONK_ACCOUNT, mint: FAKE, decimals: 6, post: [OWNER, 5_000_000] },
      ],
    });
    expect(approval((await describeIt()).effect, [])).toEqual({
      kind: "proof",
      reason: "moves 9xQeWv…VFin, which Auni can't price",
    });
  });

  it.each<[string, Partial<Scene>, string]>([
    [
      "leaves a delegate able to spend a token",
      delegated,
      "lets GZuFT72jZWfuZk4YC6diVDWJ4LZGQNQnrUNLbsYjFo5i spend your USDC",
    ],
    [
      "hands one of the wallet's token accounts to someone else",
      {
        tokens: [
          ...swap().tokens,
          { account: POOL, mint: BONK, decimals: 5, pre: [OWNER, 0], post: [APP, 0] },
        ],
      },
      "lets JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 move all your Bonk",
    ],
    [
      "changes an account an app keeps in the wallet's name",
      { before: { [POOL]: [LENDING, new Uint8Array([7, ...getAddressEncoder().encode(OWNER)])] } },
      "changes what your wallet keeps at KLend2…gmjD, which Auni can't read",
    ],
    [
      "opens an account an app keeps in the wallet's name",
      {
        accounts: {
          [POOL]: {
            owner: LENDING,
            space: 33,
            data: [
              Buffer.from([7, ...getAddressEncoder().encode(OWNER)]).toString("base64"),
              "base64",
            ],
          },
        },
      },
      "changes what your wallet keeps at KLend2…gmjD, which Auni can't read",
    ],
    [
      "opens a stake account, whose authorities could be anyone's",
      {
        accounts: {
          [POOL]: {
            owner: STAKE,
            space: 200,
            data: { program: "stake", parsed: { type: "initialized" }, space: 200 },
          },
        },
      },
      "changes what your wallet keeps at Stake1…1111, which Auni can't read",
    ],
    [
      "sets a network fee over 0.01 SOL",
      {
        fee: 20_000_000,
        lamports: { ...swap().lamports, [OWNER]: [30_000_000, 30_000_000 - 20_000_000 - RENT] },
      },
      "pays 0.02 SOL in network fees, more than a tap allows",
    ],
    [
      "moves nothing Auni can see",
      { lamports: { [OWNER]: [10_000_000, 10_000_000 - 5_000] }, tokens: [] },
      "moves nothing Auni can see",
    ],
    [
      "moves compressed NFTs, which live in trees many wallets share, beside a swap",
      { inner: ["BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY"] },
      "changes what your wallet keeps at BGUMAp…RPUY, which Auni can't read",
    ],
  ])("takes the code for one that %s", async (_, change, reason) => {
    scene = () => ({ ...swap(), ...change });
    expect(approval((await describeIt()).effect, [])).toEqual({ kind: "proof", reason });
  });

  it("buys the SOL a wallet without any needs, with its USDC, and says so beside the move", async () => {
    scene = shortSwap;
    const { effect, details } = await describeIt();
    // Read as the wallet would send it, the loan and the lender's fee left out; it buys with USDC
    // the rent, the fee and the 650,240 lamports it keeps, at $100 a SOL and a tenth over, as the
    // coin an EVM chain's fees are paid in is bought, most of which stays in the wallet, so it
    // is no cost.
    expect(effectLines(effect)).toEqual([
      { label: "You give", value: "5 USDC ($5)" },
      { label: "You get", value: "100 Bonk ($5)" },
    ]);
    expect(feeCoinsSaid([{ details: details! }])).toBe(
      "Also buys about $0.24 of SOL for network fees, most of which stays in your wallet. Bought through Jupiter.",
    );
    expect(approval(effect, [])).toEqual({ kind: "tap" });
  });

  it("refuses a wallet short of SOL with too little USDC to buy it", async () => {
    scene = shortSwap;
    vi.mocked(solanaTokenBalance).mockResolvedValue(5_000_000n);
    await expect(describeIt()).rejects.toThrow(
      "The wallet needs about 0.002144 SOL for Solana's network fees and holds too little, and too little USDC on Solana to buy it (about $0.24).",
    );
  });

  it("won't buy SOL that the transaction itself sends", async () => {
    scene = (lent) =>
      lent
        ? { fee: 10_000, lamports: { [OWNER]: [0, 1_000_000_000 - 200_000_000] }, tokens: [] }
        : { err: "InsufficientFundsForFee", lamports: {}, tokens: [] };
    await expect(describeIt()).rejects.toThrow(
      "It sends 0.2 SOL, more than the wallet holds. Buy SOL with solana_swap first",
    );
  });

  describe("execute", () => {
    /** The wallet's sends, and a top-up landing leaves the chain as `topped` says. */
    const sends = (topped: (lent: boolean) => Scene) => {
      const sent: { tx: string; options?: object }[] = [];
      const wallets = {
        solanaAddress: OWNER,
        sendSolanaTransaction: async (tx: string, options?: object) => {
          sent.push({ tx, ...(options ? { options } : {}) });
          if (tx === "top-up") scene = topped;
          return `signature-${sent.length}`;
        },
      } as unknown as Signer;
      return { sent, wallets };
    };
    const run = async (
      approvedScene: (lent: boolean) => Scene,
      now = approvedScene,
      topped: (lent: boolean) => Scene = () => swap(),
      /** What the card asked for: a tap, or a code for this reason. */
      needsStepUp?: string,
    ) => {
      scene = approvedScene;
      const preview = await describeIt();
      // As recordActions pins it.
      const details = {
        ...preview.details,
        ...pinnedApproval(preview.effect),
        ...(needsStepUp ? { needsStepUp } : {}),
      };
      const action = { id: "a", tool: "send_solana_transaction", details };
      scene = now;
      const { sent, wallets } = sends(topped);
      const input = { transaction: transaction(), summary: "Buy Bonk" };
      const result = await sendSolanaTransaction.execute({
        action: action as ActionRow,
        input,
        wallets,
        recordSent: async () => {},
        posting: (_chain, post) => post(),
      });
      return { sent, result };
    };

    it("buys the SOL it needs first, then sends it paying its own way on a fresh blockhash", async () => {
      const { sent, result } = await run(shortSwap);
      expect(sent[0]).toEqual({ tx: "top-up", options: { setup: true } });
      expect(sent[1]?.options).toEqual({ paysOwnFee: true });
      const { messageBytes } = getTransactionDecoder().decode(Buffer.from(sent[1]!.tx, "base64"));
      const sentMessage = getCompiledTransactionMessageDecoder().decode(messageBytes);
      expect(sentMessage.staticAccounts[0]).toBe(OWNER);
      expect(sentMessage.lifetimeToken).toBe(FRESH);
      expect(result.txs).toEqual([
        { chain: "solana", hash: "signature-1", setup: true },
        { chain: "solana", hash: "signature-2" },
      ]);
    });

    it("records what landed as fills, cash left out", async () => {
      const { result } = await run(() => swap());
      expect(result.fills).toEqual([
        { chain: "solana", instrument: BONK, side: "buy", quantity: "100", usdValue: "5.00" },
      ]);
    });

    // A run that stopped after its send, before it read what landed, has reconcile read it back.
    it("reads the same fills back from the landed transaction alone", async () => {
      const { result } = await run(() => swap());
      const action = { id: "a", tool: "send_solana_transaction", details: {}, txs: result.txs };
      const read = (solanaAddress: string | null, txs = result.txs) =>
        sendSolanaTransaction.readBack!({
          action: { ...action, txs } as ActionRow,
          input: { transaction: transaction(), summary: "Buy Bonk" },
          evmAddress: null,
          solanaAddress,
        });
      expect(await read(OWNER)).toEqual({ fills: result.fills });
      // With no wallet, or nothing it sent that landed, there is nothing to read yet.
      expect(await read(null)).toBeNull();
      expect(await read(OWNER, [])).toBeNull();
    });

    it("holds a tap to the transaction as it goes once the SOL is bought, not the lent copy", async () => {
      const more = (): Scene => ({
        ...swap(),
        tokens: [{ ...swap().tokens[0]!, pre: [OWNER, 6_000_000] }, swap().tokens[1]!],
      });
      await expect(run(shortSwap, shortSwap, more)).rejects.toThrow(
        "would send more than was shown",
      );
    });

    it("buys no SOL its card didn't show, and sends nothing", async () => {
      // Shown holding enough, it now holds too little: buying some is for a fresh card.
      await expect(run(() => swap(), shortSwap)).rejects.toThrow("its card showed buying none");
    });

    it("sends nothing more when the wallet is still short of SOL after buying some", async () => {
      await expect(run(shortSwap, shortSwap, shortSwap)).rejects.toThrow(
        "The wallet is still short of SOL after buying some",
      );
    });

    it("sends what the owner's proof approved, a permission and all", async () => {
      const shown = (): Scene => ({ ...swap(), ...delegated });
      const { sent } = await run(shown);
      expect(sent).toHaveLength(1);
    });

    it("holds the owner's proof to every risk its card showed, sending none it didn't", async () => {
      const shown = (): Scene => ({ ...swap(), ...delegated });
      const more = (): Scene => ({
        ...shown(),
        before: { [POOL]: [LENDING, new Uint8Array([7, ...getAddressEncoder().encode(OWNER)])] },
      });
      await expect(run(shown, more)).rejects.toThrow(
        "This now changes what your wallet keeps at KLend2…gmjD",
      );
    });

    it("holds the owner's proof to what its card showed, as a tap is", async () => {
      const more = (): Scene => ({
        ...swap(),
        tokens: [{ ...swap().tokens[0]!, pre: [OWNER, 6_000_000] }, swap().tokens[1]!],
      });
      await expect(run(shortSwap, shortSwap, more, "moves nothing Auni can see")).rejects.toThrow(
        "would send more than was shown",
      );
    });

    it("sends nothing on a tap whose simulation now sends more than its card showed", async () => {
      const more = (): Scene => ({
        ...swap(),
        tokens: [{ ...swap().tokens[0]!, pre: [OWNER, 6_000_000] }, swap().tokens[1]!],
      });
      await expect(run(() => swap(), more)).rejects.toThrow("would send more than was shown");
    });
  });
});

// A swap into SOL opens a wrapped-SOL account for the wallet and closes it once it unwraps, so a
// wallet with almost none fails it paying its own way, though it ends holding more. A sponsor pays
// the fee and that rent on a transaction it pays for (Oct 31: every bridge out of Solana failed
// buying its SOL so).
describe("simulating a swap into SOL", () => {
  const intoSol = (lent: boolean): Scene =>
    lent
      ? { fee: 10_000, lamports: { [OWNER]: [0, 1_000_000_000 + 4_000_000] }, tokens: [] }
      : { err: { InstructionError: [2, { Custom: 1 }] }, lamports: {}, tokens: [] };

  it("reads what it does when a sponsor pays its way", async () => {
    scene = intoSol;
    const simulated = await simulateSolana(transaction(), OWNER);
    expect(simulated.effect.in).toEqual([{ token: WRAPPED_SOL, amount: 4_000_000n }]);
    expect(simulated.short).toBe(0n);
  });

  it("refuses it for a wallet paying its own way, which holds too little SOL along the way", async () => {
    scene = intoSol;
    await expect(simulateSolana(transaction(), OWNER, { paysOwnFee: true })).rejects.toThrow(
      "It fails in a simulation",
    );
  });

  // Asked who pays, a wallet with no sponsor says it does, so nothing assumes a sponsor's fee payer.
  it("is read as the wallet paying its own way when it has no sponsor", async () => {
    scene = intoSol;
    sponsor.paysSolana = true;
    try {
      await expect(simulateSolana(transaction(), OWNER)).rejects.toThrow(
        "It fails in a simulation",
      );
    } finally {
      sponsor.paysSolana = false;
    }
  });
});
