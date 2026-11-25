import { AMOUNT } from "@auni/shared";
import {
  encodeAbiParameters,
  pad,
  toEventSelector,
  type Address,
  type Log,
  type TransactionReceipt,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ActionRow } from "../../db/schema.ts";
import { figureOf } from "../../test/recipe.ts";
import { approval, effectLines, pinnedApproval } from "../effect.ts";
import type { Signer } from "../recipe.ts";
import { simulateEffect, tokenNames, WouldFail, type SimulatedEffect } from "../wallet-effect.ts";
import { ownGas } from "../gas.ts";
import { coinMovedBy, confirmedReceipts } from "../swaps/evm.ts";
import { EVM_NATIVE } from "../fill-key.ts";
import { sendEvmTransaction } from "./evm.ts";

// The simulation and the wallet are stood in; the ladder and the card facts are real.
vi.mock("../wallet-effect.ts", async (original) => ({
  ...(await original()),
  simulateEffect: vi.fn(),
  tokenNames: vi.fn(),
}));
vi.mock("../app-logo.ts", () => ({ appLogo: async () => null }));
// The wallet stood in is sponsored everywhere but Ethereum.
vi.mock("../wallets.ts", async (original) => ({
  ...(await original()),
  evmAddress: async () => OWNER,
  paysOwnGas: async (chainId: number) => chainId === 1,
}));
vi.mock("../gas.ts", () => ({ ownGas: vi.fn(), ownGasFees: vi.fn() }));
vi.mock("../swaps/evm.ts", async (original) => ({
  ...(await original()),
  confirmedReceipts: vi.fn(),
  coinMovedBy: vi.fn(async () => ({ in: 0n, out: 0n })),
}));

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ROUTER = "0x2222222222222222222222222222222222222222";
/** Someone's wallet, an account that keeps what it gets. */
const FRIEND = "0x7777777777777777777777777777777777777777";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
/** A token LI.FI prices far above what it sells for. */
const JUNK = "0x4444444444444444444444444444444444444444";
vi.mocked(tokenNames).mockResolvedValue(
  new Map([
    [USDC, { symbol: "USDC", decimals: 6, usd: 1 }],
    [WETH, { symbol: "WETH", decimals: 18, usd: 4000 }],
    [JUNK, { symbol: "JUNK", decimals: 18, usd: 2289 }],
  ]),
);

/** What a simulation saw, all of it readable unless said otherwise. */
const seen = (effect: Partial<SimulatedEffect>): SimulatedEffect => ({
  out: [],
  in: [],
  grants: [],
  blind: false,
  sentTo: [],
  logs: [],
  ...effect,
});
const describeBatch = () =>
  sendEvmTransaction.describe(
    { chain: "base", calls: [{ to: ROUTER, data: "0x" }], summary: "Swap" },
    {},
  );
const sends = { token: USDC, amount: 5_000_000n } as const;

describe("send_evm_transaction", () => {
  it("lets a trade go on a tap", async () => {
    const gets = { token: WETH, amount: 2n * 10n ** 15n } as const;
    vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends], in: [gets] }));
    const card = await describeBatch();
    const { effect } = card;
    expect(effectLines(effect)).toEqual([
      { label: "You give", value: "5 USDC ($5)" },
      { label: "You get", value: "0.002 WETH ($8)" },
    ]);
    expect(approval(effect, [])).toEqual({ kind: "tap" });
    expect(card.card?.title).toBe(`Buy WETH for ${AMOUNT}`);
    expect(figureOf(card, "You pay")).toBe("5 USDC");
    expect(figureOf(card, "You get, about")).toBe("0.002 WETH");
  });

  it("reads a trade into dollars as a sell", async () => {
    const out = { token: WETH, amount: 2n * 10n ** 15n } as const;
    vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [out], in: [sends] }));
    const card = await describeBatch();
    // The card wears the logo of what it sells, not of the dollars it gets.
    expect(card.details?.mint).toBe(WETH);
    expect(card.card?.title).toBe("Sell WETH");
    expect(figureOf(card, "You sell")).toBe("0.002 WETH");
    expect(figureOf(card, "You get, about")).toBe("5 USDC");
  });

  it("asks for the owner's proof when assets leave for somewhere new with nothing back, naming where", async () => {
    vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends], sentTo: [FRIEND] }));
    const { effect } = await describeBatch();
    expect(approval(effect, [])).toEqual({
      kind: "proof",
      reason: "sends money to 0x7777…7777, where you've never sent before",
    });
    // A send, said as one: what goes, and the whole address it goes to, which the owner checks.
    expect(effectLines(effect)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "You send" }),
        { label: "To", value: FRIEND },
      ]),
    );
    expect(effectLines(effect).map(({ label }) => label)).not.toContain("You get");
    // Somewhere the owner has sent before goes on a tap.
    expect(approval(effect, [FRIEND])).toEqual({ kind: "tap" });
  });

  it("asks for the owner's proof when what comes back is a token Auni can't price, or dust", async () => {
    const FAKE = "0x3333333333333333333333333333333333333333";
    vi.mocked(simulateEffect).mockResolvedValue(
      seen({ out: [sends], in: [{ token: FAKE, amount: 1n }], sentTo: [FRIEND] }),
    );
    expect(approval((await describeBatch()).effect, [FRIEND])).toEqual({
      kind: "proof",
      reason: "moves 0x3333…3333, which Auni can't price",
    });
    vi.mocked(simulateEffect).mockResolvedValue(
      seen({ out: [sends], in: [{ token: WETH, amount: 10n ** 12n }], sentTo: [FRIEND] }),
    );
    expect(approval((await describeBatch()).effect, [FRIEND])).toEqual({
      kind: "proof",
      reason: "brings back WETH, worth under half of what it sends",
    });
  });

  it("names a permission it leaves as what it lets, and takes the owner's proof for it", async () => {
    vi.mocked(simulateEffect).mockResolvedValue(
      seen({ grants: [{ kind: "spend", token: USDC, to: ROUTER }] }),
    );
    const { effect } = await sendEvmTransaction.describe(
      { chain: "base", calls: [{ to: USDC, data: "0x" }], summary: "Approve" },
      {},
    );
    expect(effectLines(effect)).toEqual([
      { label: "Lets", value: "0x2222222222222222222222222222222222222222 spend your USDC" },
    ]);
    expect(approval(effect, [])).toEqual({
      kind: "proof",
      reason: "lets 0x2222222222222222222222222222222222222222 spend your USDC",
    });
  });

  it("refuses a batch calling the wallet's own account code", async () => {
    vi.mocked(simulateEffect).mockResolvedValue(seen({}));
    await expect(
      sendEvmTransaction.describe(
        { chain: "base", calls: [{ to: OWNER }], summary: "Upgrade" },
        {},
      ),
    ).rejects.toThrow("Auni won't send this: it calls your wallet's own account code.");
  });

  it("tells the agent which of the calls it built would have failed", async () => {
    const cause = new Error("reverted");
    vi.mocked(simulateEffect).mockRejectedValue(new WouldFail(2, 2, undefined, cause));
    const refused: unknown = await sendEvmTransaction
      .describe(
        {
          chain: "base",
          calls: [
            { to: USDC, data: "0x" },
            { to: ROUTER, data: "0x" },
          ],
          summary: "Swap",
        },
        {},
      )
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({
      message:
        "Auni ran this first and it would have failed, so it wasn't sent. The call that failed is 2 of 2.",
      cause,
    });
  });

  it("is about what it trades, else the app the agent named, else its chain", async () => {
    const about = async (input: Parameters<typeof sendEvmTransaction.describe>[0]) => {
      const { details = {} } = await sendEvmTransaction.describe(input, {});
      return sendEvmTransaction.about({ input, details, amountUsd: "0" });
    };
    const batch = { chain: "base", calls: [{ to: ROUTER }], summary: "Claim" };
    vi.mocked(simulateEffect).mockResolvedValue(seen({}));
    expect(await about(batch)).toEqual({
      kind: "app",
      name: "Base",
      logo: "/brand/chains/ethereum.svg",
    });
    const app = { name: "Merkl", site: "merkl.xyz", verb: "claim" };
    expect(await about({ ...batch, app })).toEqual({ kind: "app", name: "Merkl", logo: null });
    const gets = { token: WETH, amount: 2n * 10n ** 15n } as const;
    vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends], in: [gets] }));
    expect(await about({ ...batch, app })).toMatchObject({
      kind: "token",
      chain: "base",
      mint: WETH,
      symbol: "WETH",
    });
  });

  it("says the batch it would send, so core checks the wallet can pay its gas", async () => {
    vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends] }));
    const batch = { chain: "1", calls: [{ to: ROUTER }], summary: "Buy" };
    expect((await sendEvmTransaction.describe(batch, {})).sends).toEqual({
      chainId: 1,
      calls: batch.calls,
    });
  });

  it("dresses a swap as the app the agent named, from the simulation's numbers", async () => {
    const gets = { token: WETH, amount: 125n * 10n ** 13n } as const;
    vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends], in: [gets] }));
    const swap = (verb: string) =>
      sendEvmTransaction.describe(
        {
          chain: "base",
          calls: [{ to: ROUTER, data: "0x" }],
          summary: "Buy WETH",
          app: { name: "Uniswap", site: "https://app.uniswap.org/", verb, to_chain: "base" },
        },
        {},
      );
    const bought = await swap("swap");
    expect(bought.details?.mint).toBe(WETH);
    expect(bought.card).toMatchObject({
      title: "Buy WETH",
      context: "Uniswap on Base",
      price: "$4,000.00",
      finePrint: "It goes through 0x2222…2222.",
    });
    expect(figureOf(bought, "You get, about")).toBe("0.00125 WETH");
    expect(figureOf(bought, "Vs market")).toBe("About even");
    // A move that stays on the chain it leaves isn't one, so it draws the plain card.
    expect((await swap("move")).card).toMatchObject({
      title: "Buy WETH",
      context: "app.uniswap.org on Base",
      figures: [
        { label: "You send", value: "5 USDC", note: "$5" },
        { label: "You get", value: "0.00125 WETH", note: "$5" },
      ],
    });
  });

  describe("for a service no app covers", () => {
    const NOTE = "stETH earns about 3% a year. Turning it back into ETH can take days.";
    const gets = { token: WETH, amount: 125n * 10n ** 13n } as const;
    const stake = (note?: string) =>
      sendEvmTransaction.describe(
        {
          chain: "base",
          calls: [{ to: ROUTER, data: "0x" }],
          summary: "Stake USDC with Lido",
          app: { name: "Lido", site: "lido.fi", verb: "stake", ...(note ? { note } : {}) },
        },
        {},
      );

    it("says what it checked by running it, the agent's sentence apart, and that no app covers it", async () => {
      vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends], in: [gets] }));
      expect((await stake(NOTE)).card?.checks).toEqual({
        checked: "Checked by running it first",
        unchecked: { heading: "Not checked: what Auni says about it", says: NOTE },
        why: "No app for Lido yet, so Auni read this by running it first.",
      });
      expect((await stake()).card?.checks?.unchecked).toBeNull();
    });

    it("lets the note change no figure and no approval", async () => {
      vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends], in: [gets] }));
      const [noted, bare] = [await stake(NOTE), await stake()];
      const { card: notedFace, ...notedRest } = noted;
      const { card: bareFace, ...bareRest } = bare;
      // Everything a card is priced, approved and held to by is the same with and without it.
      expect(notedRest).toEqual(bareRest);
      expect(approval(noted.effect, [])).toEqual({ kind: "tap" });
      expect(pinnedApproval(noted.effect)).toEqual(pinnedApproval(bare.effect));
      // And so is every word of its face but the note itself.
      expect({ ...notedFace, checks: null }).toEqual({ ...bareFace, checks: null });
      expect(JSON.stringify({ ...notedFace, checks: null })).not.toContain("stETH earns");
    });

    it.each([
      ["sends money with nothing back", seen({ out: [sends], sentTo: [FRIEND] })],
      ["sends money where Auni can't say", seen({ out: [sends], sentTo: undefined })],
      [
        "leaves a permission behind",
        seen({ out: [sends], in: [gets], grants: [{ kind: "spend", token: USDC, to: ROUTER }] }),
      ],
      ["has a call Auni can't see", seen({ out: [sends], in: [gets], blind: true })],
      ["gets back under half", seen({ out: [sends], in: [{ token: WETH, amount: 10n ** 13n }] })],
    ])(
      "carries no note on a card that takes the owner's proof: one that %s",
      async (_, simulated) => {
        vi.mocked(simulateEffect).mockResolvedValue(simulated);
        const card = await stake(NOTE);
        expect(approval(card.effect, [])).toMatchObject({ kind: "proof" });
        expect(card.card?.checks).toMatchObject({ checked: "Checked by running it first" });
        expect(card.card?.checks?.unchecked).toBeNull();
        expect(JSON.stringify(card)).not.toContain("stETH earns");
      },
    );

    it("carries no note where money leaves, even for somewhere sent to before", async () => {
      vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends], sentTo: [FRIEND] }));
      const card = await stake(NOTE);
      // A tap today, the owner's proof had the owner never sent there: the card is the same either way.
      expect(approval(card.effect, [FRIEND])).toEqual({ kind: "tap" });
      expect(card.card?.checks?.unchecked).toBeNull();
    });

    it("says nothing was checked of one it couldn't simulate, and shows no note", async () => {
      vi.mocked(simulateEffect).mockResolvedValue(null);
      const card = await stake(NOTE);
      expect(approval(card.effect, [])).toMatchObject({ kind: "proof" });
      expect(card.card).toBeUndefined();
      expect(JSON.stringify(card)).not.toContain("stETH earns");
    });

    it("says Auni's own app doesn't know the contract when the agent names it", async () => {
      vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends], in: [gets] }));
      const named = (name: string, site: string) =>
        sendEvmTransaction.describe(
          {
            chain: "base",
            calls: [{ to: ROUTER, data: "0x" }],
            summary: "Stake USDC",
            app: { name, site, verb: "stake" },
          },
          {},
        );
      const why =
        "Auni's Hyperliquid app doesn't know this contract, so Auni read this by running it first.";
      // By its name, however it is written, or by its site's.
      expect((await named("Hyperliquid", "kintsu.xyz")).card?.checks?.why).toBe(why);
      expect((await named("Hyper Liquid", "kintsu.xyz")).card?.checks?.why).toBe(why);
      expect((await named("Kintsu", "app.hyperliquid.xyz")).card?.checks?.why).toBe(why);
      expect((await named("Kintsu", "kintsu.xyz")).card?.checks?.why).toBe(
        "No app for Kintsu yet, so Auni read this by running it first.",
      );
    });

    it("refuses, in every word of the agent's the card draws, what isn't plain words on one line", () => {
      const takes = (change: { summary?: string; app?: Record<string, string> }) =>
        z.object(sendEvmTransaction.input).safeParse({
          chain: "1",
          calls: [{ to: ROUTER }],
          summary: change.summary ?? "Stake",
          app: { name: "Lido", site: "lido.fi", verb: "stake", note: NOTE, ...change.app },
        }).success;
      const tricks = "Claim at evil.example now";
      expect(takes({})).toBe(true);
      expect(takes({ summary: tricks })).toBe(false);
      for (const field of ["name", "verb", "to_chain", "note"])
        expect(takes({ app: { [field]: tricks.slice(0, 24) } }), field).toBe(false);
      // A site is a website's host and nothing else, which the card draws as that.
      expect(takes({ app: { site: "lido.fi/claim?bonus" } })).toBe(true);
      expect(takes({ app: { site: "Claim your bonus" } })).toBe(false);
    });
  });

  // As on Solana: "Network fee about $0" would read as if the wallet paid nothing.
  it("says the network fee the wallet pays, on the app's card once it reaches a cent", async () => {
    vi.mocked(simulateEffect).mockResolvedValue(
      seen({ out: [sends], in: [{ token: WETH, amount: 125n * 10n ** 13n }] }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ address: "0x0", symbol: "ETH", decimals: 18, priceUSD: "4000" }),
      ),
    );
    const card = async (wei: bigint) => {
      vi.mocked(ownGas).mockResolvedValue({ short: null, fee: wei });
      return sendEvmTransaction.describe(
        {
          chain: "1",
          calls: [{ to: ROUTER, data: "0x" }],
          summary: "Buy WETH",
          app: { name: "Uniswap", site: "https://app.uniswap.org/", verb: "swap" },
        },
        {},
      );
    };
    const networkFee = async (wei: bigint) => figureOf(await card(wei), "Network fee");
    // 0.000001 ETH is 0.4¢; 0.0001 ETH is 40¢.
    expect(await networkFee(10n ** 12n)).toBeUndefined();
    expect(await networkFee(10n ** 14n)).toBe("$0.40");
    expect(effectLines((await card(10n ** 14n)).effect)).toContainEqual({
      label: "Costs",
      value: "$0.40 network fee",
    });
    vi.unstubAllGlobals();
  });

  it("judges a batch as one on every chain, since the wallet sends it whole", async () => {
    const gets = { token: WETH, amount: 2n * 10n ** 15n } as const;
    vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends], in: [gets] }));
    vi.mocked(ownGas).mockResolvedValue({ short: null, fee: 0n });
    const [approve, swap] = [{ to: USDC, data: "0x" }, { to: ROUTER }];
    const decided = async (chain: string, calls: { to: string; data?: string }[]) => {
      const { effect } = await sendEvmTransaction.describe({ chain, calls, summary: "Swap" }, {});
      return approval(effect, []);
    };
    // Paying its own gas on Ethereum, sponsored elsewhere, and off Auni's chains alike.
    expect(await decided("1", [approve, swap])).toEqual({ kind: "tap" });
    expect(await decided("base", [approve, swap])).toEqual({ kind: "tap" });
    expect(await decided("10", [approve, swap])).toEqual({ kind: "tap" });
  });

  describe("at execute", () => {
    const input = {
      chain: "base",
      calls: [{ to: ROUTER, data: "0x" }],
      summary: "Send",
    };
    /** The action as recordActions keeps it, its approval pinned beside the recipe's details. */
    const recorded = async () => {
      const { details = {}, amountUsd, effect } = await sendEvmTransaction.describe(input, {});
      return {
        tool: sendEvmTransaction.tool,
        details: { ...details, ...pinnedApproval(effect) },
        amountUsd,
      } as ActionRow;
    };
    const run = (action: ActionRow, send = vi.fn()) =>
      sendEvmTransaction.execute({
        action,
        input,
        wallets: { evmAddress: OWNER, sendEvmTransaction: send } as unknown as Signer,
        recordSent: vi.fn(),
        posting: (_chain, post) => post(),
      });

    it("sends nothing whose card showed limits once a fresh simulation can't hold it to them", async () => {
      vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends], sentTo: [FRIEND] }));
      const action = await recorded();
      // The owner's proof approved it, then the chain couldn't be simulated as it went.
      expect(action.details.leavesTo).toBe(FRIEND);
      vi.mocked(simulateEffect).mockResolvedValue(null);
      const send = vi.fn();
      await expect(run(action, send)).rejects.toThrow("can't be checked in a simulation");
      expect(send).not.toHaveBeenCalled();
    });

    it("sends nothing that would now send its money somewhere its card didn't show", async () => {
      vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends], sentTo: [FRIEND] }));
      const action = await recorded();
      vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends], sentTo: [WETH] }));
      const send = vi.fn();
      await expect(run(action, send)).rejects.toThrow("somewhere its card didn't show");
      // Nor to a contract, which could pass it on to anyone (see simulateEffect).
      vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends], sentTo: undefined }));
      await expect(run(action, send)).rejects.toThrow("somewhere its card didn't show");
      expect(send).not.toHaveBeenCalled();
    });

    it("sends nothing on a tap that would now leave a permission", async () => {
      const gets = { token: WETH, amount: 2n * 10n ** 15n } as const;
      vi.mocked(simulateEffect).mockResolvedValue(seen({ out: [sends], in: [gets] }));
      const action = await recorded();
      vi.mocked(simulateEffect).mockResolvedValue(
        seen({ out: [sends], in: [gets], grants: [{ kind: "spend", token: USDC, to: ROUTER }] }),
      );
      const send = vi.fn();
      await expect(run(action, send)).rejects.toThrow(
        "This now lets 0x2222222222222222222222222222222222222222 spend your USDC, so nothing was sent.",
      );
      expect(send).not.toHaveBeenCalled();
    });
  });
});

// A run that stopped after its batch confirmed, before it read its receipt, is read back by
// reconcile: the receipt's own transfers in and out of the wallet, as execute reads them.
describe("send_evm_transaction read back", () => {
  const transfer = (token: Address, from: Address, to: Address, amount: bigint) =>
    ({
      address: token,
      topics: [toEventSelector("Transfer(address,address,uint256)"), pad(from), pad(to)],
      data: encodeAbiParameters([{ type: "uint256" }], [amount]),
    }) as unknown as Log;
  const receipt = (...logs: Log[]) => [
    { status: "success", logs } as unknown as TransactionReceipt,
  ];
  const read = (details: Record<string, string>, evmAddress: string | null = OWNER) =>
    sendEvmTransaction.readBack!({
      action: { details, txs: [{ chain: "base", hash: "0xsent" }] } as unknown as ActionRow,
      input: { chain: "base", calls: [{ to: ROUTER, data: "0x" }], summary: "Swap" },
      evmAddress,
      solanaAddress: null,
    });

  it("reads what the receipt shows leaving and arriving, cash left out", async () => {
    vi.mocked(confirmedReceipts).mockResolvedValue(
      receipt(
        transfer(USDC, OWNER, ROUTER, 5_000_000n),
        transfer(WETH, ROUTER, OWNER, 2n * 10n ** 15n),
      ),
    );
    expect(
      await read({ sendsUpTo: `${USDC}:5000000`, getsAbout: `${WETH}:2000000000000000` }),
    ).toEqual({
      fills: [
        { chain: "base", instrument: WETH, side: "buy", quantity: "0.002", usdValue: "5.00" },
      ],
    });
    expect(confirmedReceipts).toHaveBeenLastCalledWith("base", [{ chain: "base", hash: "0xsent" }]);
  });

  it("takes the chain's coin, which leaves no log, from what its call trace moved", async () => {
    vi.mocked(tokenNames).mockResolvedValueOnce(
      new Map([
        [EVM_NATIVE, { symbol: "ETH", decimals: 18, usd: 4000 }],
        [USDC, { symbol: "USDC", decimals: 6, usd: 1 }],
      ]),
    );
    vi.mocked(confirmedReceipts).mockResolvedValue(
      receipt(transfer(USDC, ROUTER, OWNER, 8_000_000n)),
    );
    // The card showed 0.002 ETH leaving; the transaction sent 0.00196, within what execute allows.
    vi.mocked(coinMovedBy).mockResolvedValueOnce({ in: 0n, out: 1_960_000_000_000_000n });
    const card = { sendsUpTo: `${EVM_NATIVE}:2000000000000000`, getsAbout: `${USDC}:8000000` };
    expect(await read(card)).toMatchObject({
      fills: [{ instrument: "native", side: "sell", quantity: "0.00196", usdValue: "8.00" }],
    });
    // With no trace to read, a card that showed the coin moving can't be read back.
    vi.mocked(coinMovedBy).mockResolvedValueOnce(null);
    expect(await read(card)).toBeNull();
  });

  it("reads nothing before a send of it confirmed, or with no wallet", async () => {
    vi.mocked(confirmedReceipts).mockResolvedValue([]);
    expect(await read({})).toBeNull();
    expect(await read({}, null)).toBeNull();
  });
});
