import { NETWORKS } from "@auni/shared";
import { eq } from "drizzle-orm";
import { encodeFunctionData, erc20Abi, getAddress, parseAbi, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { filling } from "../apps/registry.ts";
import { db } from "../db/client.ts";
import { actions, fills, specialists } from "../db/schema.ts";
import { insertAction, insertSpecialist, insertThread, wipe } from "../test/db.ts";
import { executeAction, proposeAction } from "./actions.ts";
import { SOLANA_USDC } from "./chains.ts";
import { retryRefusal } from "./failure.ts";
import { WRAPPED_SOL } from "./fill-key.ts";
import type { PayInRequest, PayInStanding } from "./pay-in.ts";
import { specialistPot } from "./pot.ts";
import type { EvmTx, KeptTx } from "./recipe.ts";
import { recipeForTool } from "./recipes/index.ts";
import { retryAction } from "./retry.ts";
import { solForFees, topUpSol, withTopUp } from "./sol-top-up.ts";
import type { SignerOptions } from "./wallets.ts";

// The SOL a card buys for Solana's fees (sol-top-up.ts), through the whole of a move's run, as
// fee-coin.db.test.ts holds the coin an EVM chain's fees are paid in: it is the same purchase
// by the same means, so a card makes it at most once, whatever happens after, and it counts in
// a specialist's pot. Two ways to buy it are held: a wallet that pays its own way sends USDC on
// Monad to the pay-in service, and a wallet with a sponsor swaps its Solana USDC.

const EVM: Address = "0x2222222222222222222222222222222222222222";
const SOLANA = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MONAD = NETWORKS.monad.viem.id;
const MONAD_USDC = getAddress(NETWORKS.monad.usdc);
/** What the move is short of SOL for its fee and rent: 0.004 SOL, 40 cents at $100. */
const SHORT = 4_000_000n;
const ORDER: Hex = `0x${"ab".repeat(32)}`;

const world = vi.hoisted(() => ({
  /** Whether no sponsor pays Solana's fees, so the wallet buys through the pay-in service. */
  ownWay: true,
  /** What the move is short of SOL now, in lamports. */
  short: 0n,
  /** Where the pay-in service says the order stands. */
  relay: "success" as PayInStanding["status"],
  /** Whether the SOL shows in the wallet as the purchase lands. */
  pays: true,
  /** The wallet's SOL on Solana, in lamports, which a purchase that pays raises. */
  sol: 0n,
  direction: "buy" as "buy" | "sell",
  sent: [] as { kind: "deposit" | "swap" | "move"; txs?: readonly EvmTx[] }[],
  /** What the move's own send throws, once. */
  moveThrows: null as Error | null,
}));

vi.mock("./portfolio.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  heldNow: async () => null,
}));
vi.mock(import("./chains.ts"), async (original) => ({
  ...(await original()),
  // $5 of USDC on Monad and on Solana, and every send confirmed where it is read.
  publicClient: () => ({ readContract: async () => 5_000_000n }) as never,
  evmClient: (() => ({ getTransactionReceipt: async () => ({ status: "success" }) })) as never,
  solanaTokenBalance: async (_owner, mint) => (mint === WRAPPED_SOL ? world.sol : 5_000_000n),
  solanaRpc: (async () => ({ value: [{ err: null, confirmationStatus: "finalized" }] })) as never,
}));
vi.mock(import("./token-feeds.ts"), async (original) => ({
  ...(await original()),
  solUsd: async () => 100,
}));
vi.mock(import("./funding.ts"), async (original) => ({
  ...(await original()),
  unpaid: async () => null,
}));
vi.mock(import("./gas.ts"), () => ({
  ownGas: vi.fn(async () => ({ short: null, fee: 1n })),
  ownGasFees: vi.fn(),
  assertOwnGas: vi.fn(),
  gasLimit: vi.fn(),
}));
// What the wallet held of a coin a move trades is counted before it (other-tokens.ts); here only
// what is asked of it, and when.
const counted = vi.hoisted(() => [] as { keys: readonly unknown[]; sentBefore: number }[]);
vi.mock(import("./other-tokens.ts"), async (original) => ({
  ...(await original()),
  countBeforeTrading: async (keys) => {
    counted.push({ keys, sentBefore: world.sent.length });
  },
}));
vi.mock(import("./solana-effect.ts"), async (original) => ({
  ...(await original()),
  // The swap that buys SOL, as a simulation reads it: the card's USDC out, SOL in.
  simulateSolana: (async () => ({
    effect: {
      out: [{ token: SOLANA_USDC.mint, amount: 440_000n }],
      in: [{ token: WRAPPED_SOL, amount: 4_300_000n }],
      grants: [],
    },
  })) as never,
}));
vi.mock("./wallets.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  evmAddress: async () => EVM,
  solanaAddress: async () => SOLANA,
  walletAddresses: async () => ({ evm: EVM, solana: SOLANA }),
  paysOwnGas: async (chain: number | "solana") => chain !== "solana" || world.ownWay,
  // A wallet that keeps each send as a real one does: handed to `onSent` before it answers.
  signerFor: async (options: SignerOptions) => {
    const keep = async (kind: "deposit" | "swap" | "move", kept: KeptTx) => {
      await options.onSent(kept);
      if (kind !== "move" && world.pays) {
        world.short = 0n;
        world.sol += SHORT;
      }
      return kept.hash!;
    };
    const hash = () => `0x${(world.sent.length + 1).toString(16).padStart(64, "0")}`;
    return {
      evmAddress: EVM,
      solanaAddress: SOLANA,
      async sendEvmTransaction(_chainId: number, tx: EvmTx | readonly EvmTx[]) {
        const txs = "to" in tx ? [tx] : tx;
        const kept = { chain: "monad", hash: hash(), setup: true as const };
        world.sent.push({ kind: "deposit", txs });
        return keep("deposit", kept);
      },
      async sendSolanaTransaction(base64Tx: string, sent: { setup?: true } = {}) {
        const kind = base64Tx === "swap for SOL" ? "swap" : "move";
        if (kind === "move" && world.moveThrows) {
          const error = world.moveThrows;
          world.moveThrows = null;
          throw error;
        }
        const kept = { chain: "solana", hash: `sig${world.sent.length + 1}` };
        world.sent.push({ kind });
        return keep(kind, sent.setup ? { ...kept, setup: true } : kept);
      },
    };
  },
}));

// The pay-in app and the Solana route, as the registry gives them, answering as a test says.
const [payIn] = filling("payIn");
const [route] = filling("solana");
const depository = parseAbi([
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
]);
/** The pay-in service's answer to a request for SOL: an exact approval, then the deposit. */
function answer(request: PayInRequest) {
  const step = (id: string, to: string, data: Hex) => ({
    id,
    kind: "transaction",
    description: id,
    requestId: ORDER,
    calls: [{ chainId: MONAD, to, data, value: 0n }],
  });
  const { depository: to } = payIn!.part;
  return {
    steps: [
      step(
        "approve",
        MONAD_USDC,
        encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [to, request.amount] }),
      ),
      step(
        "deposit",
        to,
        encodeFunctionData({
          abi: depository,
          functionName: "depositErc20",
          args: [request.user, MONAD_USDC, request.amount, ORDER],
        }),
      ),
    ],
    pays: { recipient: request.recipient, ...request.to },
    out: 10_855_085n,
    least: 10_411_112n,
    gas: null,
    seconds: 1,
  };
}

/**
 * The move: the Solana swap's own recipe, by which every part of core knows the tool, standing
 * in for what it reads and sends. Like every move on Solana it works out what it is short of
 * SOL, shows buying that on its card, and buys it before its own send (solForFees, topUpSol).
 */
const recipe = recipeForTool("solana_swap")!;
const INPUT = { token: "JUP", side: "buy", amountUsd: 2 } as const;
function standIn() {
  vi.spyOn(payIn!.part, "quote").mockImplementation(async (request) => answer(request));
  vi.spyOn(payIn!.part, "status").mockImplementation(async () => ({
    status: world.relay,
    paidIn: [],
  }));
  vi.spyOn(route!.part, "build").mockImplementation(
    async () =>
      ({ quote: { minOutAmount: 4_000_000n }, transactionBase64: "swap for SOL" }) as never,
  );
  vi.spyOn(recipe, "direction").mockImplementation(() => world.direction);
  vi.spyOn(recipe, "fundedFrom").mockImplementation(() => null);
  vi.spyOn(recipe, "about").mockImplementation(() => null);
  vi.spyOn(recipe, "describe").mockImplementation(async () =>
    withTopUp(
      {
        summary: "Buy $2 of JUP",
        amountUsd: "2",
        effect: { gives: [{ text: "$2 of USDC" }], gets: [{ text: "about 4 JUP" }], grants: [] },
        details: {},
      },
      world.short > 0n ? await solForFees(world.short) : null,
    ),
  );
  vi.spyOn(recipe, "execute").mockImplementation(async ({ action, wallets }) => {
    const bought =
      world.short > 0n
        ? await topUpSol(wallets, await solForFees(world.short, { approved: action }))
        : [];
    const hash = await wallets.sendSolanaTransaction("the move");
    const fill = { chain: "solana", instrument: "JUP", quantity: "4", usdValue: "2" };
    return { txs: [...bought, { chain: "solana", hash }], fills: [{ ...fill, side: "buy" }] };
  });
}

/** A card for the move, drawn while it is short of SOL, and allowed. */
async function allowed() {
  const preview = await recipe.describe(INPUT, {});
  return insertAction({
    tool: "solana_swap",
    input: INPUT,
    amountUsd: "2",
    details: preview.details ?? {},
    status: "running",
  });
}
const row = async (id: string) => (await db.select().from(actions).where(eq(actions.id, id)))[0]!;
const count = (kind: "deposit" | "swap" | "move") =>
  world.sent.filter((sent) => sent.kind === kind).length;

/** The owner's tap on Try again, and the run it queues. */
async function tryAgain(id: string) {
  const failed = await row(id);
  expect(await retryAction(failed, failed.attempts)).toEqual({ kind: "running" });
  return executeAction(id);
}

beforeEach(async () => {
  await wipe(specialists, actions, fills);
  world.ownWay = true;
  world.short = SHORT;
  world.relay = "success";
  world.pays = true;
  world.sol = 0n;
  world.direction = "buy";
  world.sent = [];
  world.moveThrows = null;
  counted.length = 0;
  standIn();
});

// Solana's first look at its own coin counts what the wallet holds of it as put in; made after
// the purchase, it would count the SOL bought as money the owner added.
describe("the SOL a card buys, counted from before the purchase", () => {
  for (const [way, ownWay] of [
    ["through the pay-in service", true],
    ["by a swap", false],
  ] as const)
    it(way, async () => {
      world.ownWay = ownWay;
      const { id } = await allowed();
      expect((await executeAction(id)).status).toBe("done");
      expect(counted).toEqual([
        {
          keys: expect.arrayContaining([{ chain: "solana", instrument: "native" }]),
          sentBefore: 0,
        },
      ]);
    });
});

describe("SOL a card buys through the pay-in service, through a move's whole run", () => {
  it("buys once what the card showed, keeps it as the card's purchase, then sends the move", async () => {
    const { id } = await allowed();
    const done = await executeAction(id);
    expect(done.status).toBe("done");
    expect([count("deposit"), count("move")]).toEqual([1, 1]);
    // A dollar of Monad's USDC, the least a pay-in is asked for: approved exactly and deposited.
    expect(world.sent[0]!.txs).toHaveLength(2);
    expect(done.txs[0]).toMatchObject({ chain: "monad", setup: true, buysFees: ORDER });
    expect(done.txs.filter((tx) => tx.buysFees)).toHaveLength(1);
  });

  it("never buys again on Try again once the service refunded or kept the deposit and paid nothing", async () => {
    for (const [relay, says] of [
      [
        "refunded",
        "Relay refunded the $1 of USDC this card sent it from Monad rather than pay the SOL, so the move wasn't sent. Ask Auni for it again: a new card shows what it buys.",
      ],
      [
        "failed",
        "Relay has the $1 of USDC this card sent it from Monad, paid no SOL, and says it can't refund it by itself. The move wasn't sent. Ask Auni for the order's id to take up with Relay.",
      ],
    ] as const) {
      await wipe(actions);
      world.sent = [];
      world.short = SHORT;
      world.relay = relay;
      world.pays = false;
      const { id } = await allowed();
      const stopped = await executeAction(id);
      expect(stopped).toMatchObject({ status: "failed", failureKind: "fees", error: says });
      expect(retryRefusal(stopped)).toBeNull();
      for (const attempts of [2, 3]) {
        const again = await tryAgain(id);
        expect(again).toMatchObject({ status: "failed", failureKind: "fees", attempts });
      }
      expect([count("deposit"), count("move")]).toEqual([1, 0]);
    }
  });

  it("sends the move on Try again once the SOL has come, with nothing bought twice", async () => {
    world.relay = "failed";
    world.pays = false;
    const { id } = await allowed();
    expect((await executeAction(id)).failureKind).toBe("fees");
    // The SOL arrives after all, or the owner sends some.
    world.short = 0n;
    expect((await tryAgain(id)).status).toBe("done");
    expect([count("deposit"), count("move")]).toEqual([1, 1]);
  });

  it("buys nothing more when the move's own send failed after the purchase and it is short again", async () => {
    world.moveThrows = new Error("fetch failed");
    const { id } = await allowed();
    expect(await executeAction(id)).toMatchObject({ status: "failed", failureKind: "glitch" });
    world.short = SHORT;
    const again = await tryAgain(id);
    expect(again).toMatchObject({
      status: "failed",
      failureKind: "fees",
      error:
        "The SOL this card bought through Relay no longer covers the network fee, and a card buys once. Ask Auni for it again: a new card shows what it buys.",
    });
    expect([count("deposit"), count("move")]).toEqual([1, 0]);
  });
});

describe("SOL a card buys by swapping the wallet's Solana USDC, where a sponsor pays its fees", () => {
  beforeEach(() => {
    world.ownWay = false;
  });

  it("swaps once what the card showed, keeps it as the card's purchase, then sends the move", async () => {
    const { id } = await allowed();
    const done = await executeAction(id);
    expect(done.status).toBe("done");
    expect([count("swap"), count("deposit"), count("move")]).toEqual([1, 0, 1]);
    expect(done.txs[0]).toMatchObject({ chain: "solana", setup: true, buysFees: "swap" });
  });

  it("swaps nothing more on Try again when the move's own send failed and it is short again", async () => {
    world.moveThrows = new Error("fetch failed");
    const { id } = await allowed();
    expect(await executeAction(id)).toMatchObject({ status: "failed", failureKind: "glitch" });
    world.short = SHORT;
    const again = await tryAgain(id);
    expect(again).toMatchObject({
      status: "failed",
      failureKind: "fees",
      error:
        "The SOL this card bought no longer covers the network fee, and a card buys once. Ask Auni for it again: a new card shows what it buys.",
    });
    expect([count("swap"), count("move")]).toEqual([1, 0]);
  });
});

describe("a specialist that acts on its own, and the SOL its move would buy", () => {
  /** A specialist set to act on its own within `potUsd`, proposing the $2 buy in its own thread. */
  async function proposes(potUsd: string) {
    const specialist = await insertSpecialist({ potUsd, actMode: "within_limits" });
    const own = await insertThread({ specialistId: specialist.id });
    const outcome = await proposeAction(
      { threadId: own.id, specialistId: specialist.id },
      recipe,
      INPUT,
    );
    const free = async () =>
      (await db.transaction((tx) => specialistPot(tx, specialist))).freeCashCents;
    return { outcome, free };
  }

  it("asks the owner where the buy and the dollar that buys its SOL don't both fit the pot", async () => {
    const { outcome } = await proposes("2");
    expect(outcome.status).toBe("awaiting_permission");
    expect(world.sent).toEqual([]);
  });

  it("runs unasked where both fit, and counts the purchase in the pot from then on", async () => {
    const { outcome, free } = await proposes("5");
    expect(outcome.status).toBe("running");
    expect(await free()).toBe(200n);
    expect((await executeAction(outcome.action.id)).status).toBe("done");
    expect(count("deposit")).toBe(1);
    // Spent for good: $2 into the holding, a dollar to the pay-in service.
    expect(await free()).toBe(200n);
  });

  it("weighs a swap of its Solana USDC for SOL the same way", async () => {
    world.ownWay = false;
    // 40 cents of SOL at a tenth over: 44 cents beside the $2.
    expect((await proposes("2.43")).outcome.status).toBe("awaiting_permission");
    await wipe(specialists, actions);
    const { outcome, free } = await proposes("2.44");
    expect(outcome.status).toBe("running");
    expect(await free()).toBe(0n);
  });
});
