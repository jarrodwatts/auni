import { readFileSync } from "node:fs";

import { fillFace } from "@auni/shared";
import {
  decodeFunctionData,
  erc20Abi,
  getAddress,
  maxUint256,
  parseAbi,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRow } from "../../db/schema.ts";
import { PriceMoved } from "../../money/approved.ts";
import { effectLines } from "../../money/effect.ts";
import { Refused } from "../../money/refused.ts";
import { simulateEffect, walletEffect } from "../../money/wallet-effect.ts";
import { evmAddress } from "../../money/wallets.ts";
import { walletsFor } from "../../test/wallets.ts";
import { CONTRACTS } from "./http.ts";
import { runBatch } from "./relayer.ts";
import { depositWallet, erc20Balance } from "./wallet.ts";
import { homeCalls, polymarketWithdraw, SWAP_ROUTER } from "./withdraw.ts";

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;

/** The batch for 1 pUSD as Polygon's nodes ran it first for a real deposit wallet (see its `from`). */
const ranFirst = fixture<{
  readonly owner: Address;
  readonly wallet: Address;
  readonly amount: string;
  readonly logs: Log[];
}>("cash-home-run-first.json");
/** A batch of the same four calls that Polymarket's relayer carried on chain (see its `from`). */
const relayed = fixture<{
  readonly status: string;
  readonly to: Address;
  readonly wallet: Address;
  readonly calls: { readonly target: Address; readonly value: string; readonly data: Hex }[];
  readonly logs: Log[];
}>("cash-home-relayed.json");

const router = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);
const swapOf = (data: Hex) => decodeFunctionData({ abi: router, data }).args[0];

vi.mock(import("./wallet.ts"), async (original) => ({
  ...(await original()),
  depositWallet: vi.fn(),
  erc20Balance: vi.fn(),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: vi.fn(),
}));
vi.mock(import("../../money/wallet-effect.ts"), async (original) => ({
  ...(await original()),
  simulateEffect: vi.fn(),
}));
vi.mock(import("./relayer.ts"), async (original) => ({
  ...(await original()),
  runBatch: vi.fn(async () => "0xhome"),
}));

const { owner: OWNER, wallet: WALLET } = ranFirst;

/** The world as it was recorded: the wallet holds `cash`, and running the batch first pays what the nodes said. */
function world(cash: bigint) {
  vi.mocked(evmAddress).mockResolvedValue(OWNER);
  vi.mocked(depositWallet).mockResolvedValue({ address: WALLET, deployed: true });
  vi.mocked(erc20Balance).mockResolvedValue(cash);
  vi.mocked(simulateEffect).mockImplementation(async (_chainId, owner) => ({
    ...walletEffect(ranFirst.logs, owner),
    blind: false,
    logs: ranFirst.logs,
  }));
}

beforeEach(() => {
  vi.mocked(runBatch).mockClear();
  vi.mocked(simulateEffect).mockClear();
  world(1_947_719n);
});

describe("the batch that brings cash home", () => {
  it("makes the four calls a batch Polymarket's relayer carried made, with its first approval exact", () => {
    expect(relayed.status).toBe("success");
    expect(getAddress(relayed.to)).toBe(CONTRACTS.walletFactory);
    const theirs = relayed.calls;
    const paid = swapOf(theirs[3]!.data);
    const ours = homeCalls(relayed.wallet, paid.recipient, paid.amountIn, paid.amountOutMinimum);
    expect(ours.map(({ target }) => target)).toEqual(
      theirs.map(({ target }) => getAddress(target)),
    );
    // The unwrap and the router's approval are theirs byte for byte, and the swap but for its deadline.
    expect(ours[1]!.data).toBe(theirs[1]!.data);
    expect(ours[2]!.data).toBe(theirs[2]!.data);
    expect({ ...swapOf(ours[3]!.data), deadline: paid.deadline }).toEqual(paid);
    // Theirs lets the offramp take any amount ever after; Auni's lets it take this unwrap's.
    const approval = (data: Hex) => decodeFunctionData({ abi: erc20Abi, data }).args;
    expect(approval(theirs[0]!.data)).toEqual([CONTRACTS.collateralOfframp, maxUint256]);
    expect(approval(ours[0]!.data)).toEqual([CONTRACTS.collateralOfframp, paid.amountIn]);
  });

  it("moved, on chain, the pUSD out of the deposit wallet and USDC to the one address its swap named", () => {
    const { recipient, amountIn } = swapOf(relayed.calls[3]!.data);
    expect(walletEffect(relayed.logs, relayed.wallet)).toMatchObject({
      out: [{ token: CONTRACTS.pusd, amount: amountIn }],
      in: [],
    });
    expect(walletEffect(relayed.logs, recipient)).toMatchObject({
      out: [],
      in: [{ token: CONTRACTS.usdc, amount: 999_962n }],
    });
  });

  it("run first for a real deposit wallet, takes exactly the pUSD asked and pays its owner USDC", () => {
    const amount = BigInt(ranFirst.amount);
    const there = walletEffect(ranFirst.logs, WALLET);
    // The USDC.e the offramp pays in is all swapped on, so none of it stays or shows.
    expect(there).toMatchObject({ out: [{ token: CONTRACTS.pusd, amount }], in: [] });
    // What it sends goes to pUSD's own contract, which burns it, and to the pool: no one else.
    expect(there.sentTo).toEqual([
      CONTRACTS.pusd,
      getAddress("0xd36ec33c8bed5a9f7b6630855f1533455b98a418"),
    ]);
    expect(walletEffect(ranFirst.logs, OWNER)).toMatchObject({
      out: [],
      in: [{ token: CONTRACTS.usdc, amount: 999_968n }],
      grants: [],
    });
  });
});

describe("polymarket_withdraw's card", () => {
  it("says what leaves Polymarket and the least that arrives, from what running it first paid", async () => {
    const card = await polymarketWithdraw.describe({ amountUsd: 1 }, {});
    // Run as the deposit wallet runs it, for the owner's own wallet, asking no least yet.
    const [chainId, owner, calls, options] = vi.mocked(simulateEffect).mock.lastCall!;
    expect([chainId, owner, options]).toEqual([137, OWNER, { from: WALLET }]);
    expect(swapOf(calls.at(-1)!.data as Hex)).toMatchObject({
      recipient: OWNER,
      amountIn: 1_000_000n,
      amountOutMinimum: 0n,
    });
    expect(card.summary).toBe("Bring $1 of your Polymarket cash back to your wallet on Polygon");
    expect(card.amountUsd).toBe("1.00");
    // A tenth of a percent under the 0.999968 USDC the nodes said it pays.
    expect(card.details).toEqual({ getsAtLeast: "0.998968" });
    expect(effectLines(card.effect)).toEqual([
      { label: "You give", value: "$1 of Polymarket cash" },
      { label: "You get", value: "at least $0.99 of USDC in your wallet on Polygon" },
      { label: "Costs", value: "under $0.01 to the pool" },
    ]);
    // Nothing leaves the owner for somewhere else and nothing is granted, so a tap allows it.
    expect(card.effect.grants).toEqual([]);
    expect(card.effect.to).toBeUndefined();
    const face = fillFace(card.card!, {
      baseUnits: "1000000",
      currency: { code: "USDC", decimals: 6 },
    });
    expect(face).toMatchObject({
      title: "Bring cash back from Polymarket",
      action: "Bring back $1",
      context: "To your own wallet on Polygon",
      figures: [
        { label: "Leaves Polymarket", value: "$1" },
        { label: "You get, about", value: "$1 of USDC" },
        { label: "You get, at least", value: "$0.99 of USDC" },
      ],
      receipt: { title: "Brought cash back from Polymarket", amount: "$1" },
    });
    expect(face.finePrint).toBe(
      "Polymarket's dollars become USDC through a pool, so about what leaves arrives, and never less than the least shown here. Your bets stay where they are.",
    );
  });

  it("brings all the cash there when no amount is named, in whole cents as a card keeps its amount", async () => {
    world(1_009_999n);
    const card = await polymarketWithdraw.describe({}, {});
    expect(card.summary).toBe("Bring all your Polymarket cash ($1) back to your wallet on Polygon");
    expect(card.amountUsd).toBe("1.00");
    expect(swapOf(vi.mocked(simulateEffect).mock.lastCall![2].at(-1)!.data as Hex).amountIn).toBe(
      1_000_000n,
    );
    expect(card.card!.finePrint).toMatch(/^That is all the cash there now\. /u);
  });

  it("offers no card for more than the cash there, for nothing, or before there is a wallet", async () => {
    await expect(polymarketWithdraw.describe({ amountUsd: 5 }, {})).rejects.toThrow(
      "Your Polymarket wallet holds $1.94 of cash, less than the $5 asked for.",
    );
    // A part of a cent is not cash a card can name.
    world(9_999n);
    await expect(polymarketWithdraw.describe({}, {})).rejects.toThrow(
      "Your Polymarket wallet holds no cash to bring back.",
    );
    await expect(polymarketWithdraw.describe({ amountUsd: 0.004 }, {})).rejects.toThrow(
      "That is under a cent, too little to bring back.",
    );
    vi.mocked(depositWallet).mockResolvedValue({ address: WALLET, deployed: false });
    await expect(polymarketWithdraw.describe({ amountUsd: 1 }, {})).rejects.toThrow(
      "There is no Polymarket wallet of yours yet",
    );
    expect(simulateEffect).not.toHaveBeenCalled();
  });

  it("offers no card while the pool would keep more than a hundredth of it", async () => {
    vi.mocked(simulateEffect).mockResolvedValue({
      out: [],
      in: [{ token: CONTRACTS.usdc, amount: 980_000n }],
      grants: [],
      blind: false,
      logs: [],
    });
    await expect(polymarketWithdraw.describe({ amountUsd: 1 }, {})).rejects.toThrow(
      "is short right now: $1 would come back as $0.98",
    );
  });

  it("says what Polymarket's contracts refuse it with in the owner's words, and that it couldn't be checked", async () => {
    // The offramp's own error for an asset it has paused, as a node gave it (fixtures/problems).
    vi.mocked(simulateEffect).mockRejectedValue(
      new Error("Auni ran this first and step 2 of 4 would have failed.", {
        cause: { data: "0x49b8b3ac" },
      }),
    );
    const paused = await polymarketWithdraw.describe({ amountUsd: 1 }, {}).catch((error) => error);
    expect(paused).toBeInstanceOf(Refused);
    expect((paused as Refused).kind).toBe("busy");
    expect((paused as Error).message).toContain("has paused turning its dollars back into USDC");
    vi.mocked(simulateEffect).mockResolvedValue(null);
    await expect(polymarketWithdraw.describe({ amountUsd: 1 }, {})).rejects.toThrow(
      "Auni couldn't check this on Polygon just now, so nothing was sent.",
    );
  });
});

describe("polymarket_withdraw's run", () => {
  const wallets = walletsFor(`0x${"11".repeat(32)}`, OWNER);
  const run = (action: Pick<ActionRow, "amountUsd" | "details">) =>
    polymarketWithdraw.execute({
      input: {},
      action: action as ActionRow,
      wallets,
      recordSent: async () => {},
      posting: (_chain, post) => post(),
    });
  const allOfADollar = async () => {
    world(1_000_000n);
    const card = await polymarketWithdraw.describe({}, {});
    return { amountUsd: card.amountUsd, details: card.details! };
  };

  it("sends one batch, as the move itself, that brings the card's amount and holds the swap to its least", async () => {
    const result = await run(await allOfADollar());
    expect(result).toEqual({ txs: [{ chain: "polygon", hash: "0xhome" }], fills: [] });
    expect(runBatch).toHaveBeenCalledOnce();
    const [, wallet, batch] = vi.mocked(runBatch).mock.lastCall!;
    expect(wallet).toBe(WALLET);
    expect(batch).toMatchObject({ metadata: "auni cash home", setup: false });
    expect(batch.funding).toBeUndefined();
    expect(swapOf(batch.calls[3]!.data)).toMatchObject({
      recipient: OWNER,
      amountIn: 1_000_000n,
      amountOutMinimum: 998_968n,
    });
    // What it sent is what it ran first.
    expect(vi.mocked(simulateEffect).mock.lastCall![2]).toEqual(
      batch.calls.map(({ target, data }) => ({ to: target, data })),
    );
  });

  it("brings its card's amount and no more, though more cash reached the wallet after the card", async () => {
    const card = await allOfADollar();
    world(5_000_000n);
    await run(card);
    const [, , batch] = vi.mocked(runBatch).mock.lastCall!;
    expect(batch.calls.map(({ target }) => target)).toEqual([
      CONTRACTS.pusd,
      CONTRACTS.collateralOfframp,
      CONTRACTS.usdce,
      SWAP_ROUTER,
    ]);
    expect(swapOf(batch.calls[3]!.data).amountIn).toBe(1_000_000n);
  });

  it("sends nothing once the wallet holds less than its card brings", async () => {
    const card = await allOfADollar();
    world(400_000n);
    await expect(run(card)).rejects.toThrow(
      "Your Polymarket wallet now holds $0.40 of cash, less than the $1 on this card, so nothing moved.",
    );
    expect(simulateEffect).toHaveBeenCalledOnce();
    expect(runBatch).not.toHaveBeenCalled();
  });

  it("sends nothing once running it first pays under the card's least, or for a card that names none", async () => {
    const card = await allOfADollar();
    vi.mocked(simulateEffect).mockResolvedValue({
      out: [],
      in: [{ token: CONTRACTS.usdc, amount: 998_967n }],
      grants: [],
      blind: false,
      logs: [],
    });
    await expect(run(card)).rejects.toBeInstanceOf(PriceMoved);
    await expect(run({ amountUsd: "1.00", details: {} })).rejects.toThrow(
      "This card doesn't say the least it brings back. Nothing was sent.",
    );
    expect(runBatch).not.toHaveBeenCalled();
  });
});
