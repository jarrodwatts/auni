import { readFileSync } from "node:fs";

import { NETWORKS } from "@auni/shared";
import { decodeFunctionData, erc20Abi, getAddress, parseGwei, type Address } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { keepingFees, type PreparedLeg } from "../../money/actions.ts";
import {
  feeCoinCash,
  feeCoinsSaid,
  feeCoinTrades,
  feeCoinUsd,
  withFeeCoin,
} from "../../money/fee-coin-said.ts";
import { payingFees, topUpFor } from "../../money/fee-coin.ts";
import { EVM_NATIVE } from "../../money/fill-key.ts";
import {
  FeesUnpaid,
  NothingMoved,
  type ActionPreview,
  type EvmTx,
  type KeptTx,
  type Recipe,
} from "../../money/recipe.ts";
import { OWNER, recordingWallets, type Signed } from "../../test/wallets.ts";

// The swap a card makes for a chain's fee coin out of that chain's own USDC (money/fee-coin.ts),
// held to its card the way every money tool is (test/held-to-card.ts): what is signed is exactly
// the card's USDC, approved to KyberSwap's router alone, swapped for MON paid to the wallet, and
// nothing else; once the world moves past the card, nothing of it is signed; and a card swaps
// once. It is no tool of its own, so it is drilled here, beside the route it goes through.
//
// The world is the new owner's wallet of 2026-11-14 on Monad, after two $1 stock buys that cost
// 0.10 and 0.16 MON: 0.7396 MON and $0.50 of USDC, read on chain that day. Monad's fees then were
// a 100 gwei base and a 15 gwei tip, and it charges a send its whole gas limit. A stock buy's send
// carried 1,391,135 gas; the swap's, which also delegated the account, 562,708 on a fork of Monad
// (apps/local-key/fee-coin-swap.fork.db.test.ts). KyberSwap's answers are recorded (./fixtures).

const MONAD = NETWORKS.monad.viem.id;
const USDC = getAddress(NETWORKS.monad.usdc);
const MON = 10n ** 18n;
const SOMEONE: Address = "0x3333333333333333333333333333333333333333";

const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/swap-monad-usdc-to-mon.json", import.meta.url), "utf8"),
) as {
  routes: { data: { routeSummary: { amountOut: string } } };
  build: { data: { amountOut: string; data: string; routerAddress: string } };
};
const ROUTER = getAddress(recorded.build.data.routerAddress);
/** What KyberSwap said the quarter brings: 14.92 MON. */
const BRINGS = BigInt(recorded.build.data.amountOut);

/** Monad's fee history that day: every base fee 100 gwei, the middle tip 15 gwei. */
const FEE_HISTORY = {
  baseFeePerGas: Array.from({ length: 11 }, () => parseGwei("100")),
  reward: [15, 15, 15, 51, 80, 15, 80, 15, 15, 15].map((tip) => [parseGwei(String(tip))]),
};
/** The one send the wallet makes for a move's calls (see asSent), by what it is. */
const SENDS = { move: "0x01", swap: "0x02" } as const;
/** What Monad's node estimated each at: a quarter under the limit each send carried. */
const ESTIMATES = { [SENDS.move]: 1_112_908n, [SENDS.swap]: 450_166n };

const world = vi.hoisted(() => ({
  mon: 0n,
  usdc: 0n,
  /** What KyberSwap answers, as recorded unless a test changes it after the card. */
  brings: 0n,
  sponsored: false,
  /** What a simulation of the swap's batch says it moves, from the wallet. */
  moves: null as null | ((asked: { usdc: bigint; brings: bigint }) => unknown),
  /** What the card's sums say: null when they pay. */
  unpaid: null as string | null,
  /** How often KyberSwap was asked. */
  asked: 0,
}));

const chain = {
  chain: { name: "Monad", nativeCurrency: { symbol: "MON", decimals: 18 } },
  getBalance: async () => world.mon,
  // The wallet's USDC; and its allowance to the router, which is none.
  readContract: async ({ functionName }: { functionName: string }) =>
    functionName === "balanceOf" ? world.usdc : 0n,
  getFeeHistory: async () => FEE_HISTORY,
  estimateGas: async ({ data }: { data: keyof typeof ESTIMATES }) => ESTIMATES[data],
  // Monad reports the whole limit a call was given as the gas it used.
  simulateBlocks: async ({ blocks }: { blocks: { calls: { gas?: bigint }[] }[] }) => [
    { calls: blocks[0]!.calls.map(({ gas }) => ({ gasUsed: gas ?? 150_000_000n })) },
  ],
  waitForTransactionReceipt: async ({ hash }: { hash: string }) => ({
    status: "success",
    transactionHash: hash,
    blockNumber: 2n,
    from: OWNER.evm,
    gasUsed: 0n,
    effectiveGasPrice: 0n,
    logs: [],
  }),
  request: async () => ({ type: "CALL", from: OWNER.evm, to: OWNER.evm, value: "0x0" }),
};
vi.mock(import("../../money/chains.ts"), async (original) => ({
  ...(await original()),
  evmClient: (() => chain) as never,
  publicClient: (() => chain) as never,
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => OWNER.evm,
  paysOwnGas: async (chain) => chain === MONAD && !world.sponsored,
  asSent: async (_chainId, owner, txs) => ({
    to: owner,
    data: txs.some((tx) => getAddress(tx.to) === ROUTER) ? SENDS.swap : SENDS.move,
    value: 0n,
  }),
}));
vi.mock(import("../../money/token-feeds.ts"), async (original) => ({
  ...(await original()),
  feedListing: (async () => ({ usdPrice: 0.01685 })) as never,
}));
vi.mock(import("../../money/funding.ts"), async (original) => ({
  ...(await original()),
  unpaid: async () => world.unpaid,
}));
// KyberSwap's recorded answers, through its app's own reading of them; the router's bytes are
// run in a simulation core reads, stood in here by what it says the batch moves.
vi.mock(import("../../money/swaps/shared.ts"), async (original) => ({
  ...(await original()),
  fetchJson: (async (url: string | URL) => {
    world.asked += 1;
    const answer = structuredClone(
      String(url).endsWith("/route/build") ? recorded.build : recorded.routes,
    ) as never as { data: { amountOut?: string; routeSummary?: { amountOut: string } } };
    if (answer.data.routeSummary) answer.data.routeSummary.amountOut = world.brings.toString();
    else answer.data.amountOut = world.brings.toString();
    return answer;
  }) as never,
}));
vi.mock(import("../../money/swaps/routes.ts"), async (original) => ({
  ...(await original()),
  quoteSwap: async (request) => (await import("./kyberswap.ts")).quoteKyberSwap(request),
}));
vi.mock(import("../../money/wallet-effect.ts"), async (original) => ({
  ...(await original()),
  simulateEffect: (async (_chainId: number, _owner: string, calls: readonly EvmTx[]) => {
    const [approve] = calls;
    const approved = decodeFunctionData({ abi: erc20Abi, data: approve!.data as `0x${string}` });
    const asked = { usdc: approved.args[1] as bigint, brings: (BRINGS * 995n) / 1000n };
    return (
      world.moves?.(asked) ?? {
        out: [{ token: USDC, amount: asked.usdc }],
        in: [{ token: EVM_NATIVE, amount: asked.brings }],
        grants: [],
      }
    );
  }) as never,
}));

/** The live wallet (see the top), with nothing changed since any card. */
beforeEach(() => {
  world.mon = 739_554_019n * 10n ** 9n;
  world.usdc = 500_000n;
  world.brings = BRINGS;
  world.sponsored = false;
  world.moves = null;
  world.unpaid = null;
  world.asked = 0;
});

/** A $0.20 stock buy on Monad, as its card names the chain it sends on. */
const buy: ActionPreview = {
  summary: "Buy about $0.20 of NVIDIA on Monad",
  amountUsd: "0.20",
  effect: { gives: [{ text: "$0.20 of USDC" }], gets: [{ text: "about 0.001 NVDAx" }], grants: [] },
  details: { chain: "monad" },
  sends: { chainId: MONAD },
};
/** The buy's batch, as its route would send it once allowed. */
const calls: EvmTx[] = [
  { to: USDC, data: "0x095ea7b3", setup: true },
  { to: SOMEONE, data: "0xabcdef" },
];

/** The card as core draws it for one move (keepingFees in money/actions.ts). */
async function card(): Promise<ActionPreview> {
  const bought = await topUpFor(MONAD, 1);
  return bought ? withFeeCoin(buy, bought) : buy;
}

/** Runs the buy's send with the wallet execute hands a recipe (payingFees), and says what was signed. */
async function run(details: Record<string, string>, txs: readonly KeptTx[] = []) {
  const wallets = recordingWallets();
  const outcome = await (
    await payingFees(
      { details, txs: [...txs] },
      async () => wallets,
      async () => {},
      {
        chain: "monad",
        usdc: 200_000n,
      },
    )
  )
    .sendEvmTransaction(MONAD, calls)
    .then(
      () => ({ refused: null }),
      (error: unknown) => ({ refused: error }),
    );
  return { signed: wallets.signed as Signed, ...outcome };
}

const NOTHING = { evm: [], solana: [], typed: [] };
const MOVE_ALONE = { evm: [{ chainId: MONAD, txs: calls }], solana: [], typed: [] };
/** A wallet whose MON can't pay for the buy, at 0.299 MON on hand, but can for the swap, at 0.121. */
const SHORT = 2n * 10n ** 17n;

/** Fails unless `signed` is the card's swap and then the buy, and nothing else. */
function swapThenMove(signed: Signed, details: Record<string, string>) {
  const [swap, move, ...more] = signed.evm;
  expect(more).toEqual([]);
  expect([signed.solana, signed.typed]).toEqual([[], []]);
  expect(swap!.chainId).toBe(MONAD);
  const [approve, routed, ...extra] = swap!.txs;
  expect(extra).toEqual([]);
  // Exactly the card's USDC, approved to KyberSwap's router alone.
  expect(getAddress(approve!.to)).toBe(USDC);
  const { functionName, args } = decodeFunctionData({
    abi: erc20Abi,
    data: approve!.data as `0x${string}`,
  });
  expect(functionName).toBe("approve");
  expect(args).toEqual([ROUTER, BigInt(details.feeCoinAmount!)]);
  // Then the router's own call, carrying no MON, as KyberSwap built it for this wallet.
  expect(routed).toMatchObject({ to: ROUTER, value: "0", data: recorded.build.data.data });
  // Both kept as the card's purchase, never as the move.
  for (const each of swap!.txs) expect(each).toMatchObject({ setup: true, buysFees: "swap" });
  expect(move).toEqual({ chainId: MONAD, txs: calls });
}

describe("the swap a card makes for Monad's fee coin is held to its card", () => {
  it("pins a quarter of a dollar of the wallet's own USDC on Monad, for MON there, through KyberSwap", async () => {
    const shown = await card();
    expect(shown.details).toMatchObject({
      feeCoinOn: "monad",
      feeCoinFrom: "monad",
      feeCoinToken: USDC,
      feeCoinAmount: "250000",
      feeCoinUsd: "0.25",
      feeCoinBy: "KyberSwap",
    });
    // No cost, as what the fees don't use of the MON stays the owner's: the card's costs are the
    // buy's own. It is still cash spent on Monad, in a pot and a plan's sums; and MON counts from
    // before it.
    expect(shown.effect).toEqual(buy.effect);
    expect(feeCoinUsd(shown.details!)).toBe("0.25");
    expect(feeCoinCash(shown.details!)).toEqual({ from: "monad", usd: "0.25" });
    expect(feeCoinTrades(shown.details!)).toEqual([{ chain: "monad", instrument: "native" }]);
  });

  it("signs only what its card showed: the swap of the card's USDC, then the move", async () => {
    const shown = await card();
    const { signed, refused } = await run(shown.details!);
    expect(refused).toBeNull();
    swapThenMove(signed, shown.details!);
  });

  it("buys first for a move the MON can't pay for, while it still pays for the swap", async () => {
    world.mon = SHORT;
    const shown = await card();
    expect(shown.details?.feeCoinAmount).toBe("250000");
    const { signed, refused } = await run(shown.details!);
    expect(refused).toBeNull();
    swapThenMove(signed, shown.details!);
  });

  it("swaps nothing where the move by then leaves enough MON for the moves after it", async () => {
    const shown = await card();
    world.mon = 10n * MON;
    const { signed, refused } = await run(shown.details!);
    expect(refused).toBeNull();
    expect(signed).toEqual(MOVE_ALONE);
  });

  describe.each([
    ["the move can pay its own way: the move goes alone", null, MOVE_ALONE],
    ["the move can't pay its own way: nothing is signed", SHORT, NOTHING],
  ] as const)("once the world moved past the card, where %s", (_where, mon, expected) => {
    const after = async (change: () => void) => {
      if (mon !== null) world.mon = mon;
      const shown = await card();
      change();
      return run(shown.details!);
    };
    const refusedIf = (refused: unknown) =>
      mon === null ? expect(refused).toBeNull() : expect(refused).toBeInstanceOf(NothingMoved);

    it("the price moved: the card's USDC brings under a fair share of its worth", async () => {
      // 0.225 dollars' worth is 13.35 MON at the feed's price; KyberSwap now brings 13.
      const { signed, refused } = await after(() => (world.brings = 13n * MON));
      refusedIf(refused);
      expect(signed).toEqual(expected);
    });

    it("it would take more: the swap's batch would spend a unit more USDC than the card's", async () => {
      const { signed, refused } = await after(
        () =>
          (world.moves = ({ usdc, brings }) => ({
            out: [{ token: USDC, amount: usdc + 1n }],
            in: [{ token: EVM_NATIVE, amount: brings }],
            grants: [],
          })),
      );
      if (mon !== null) expect(String(refused)).toContain("send more than was shown");
      expect(signed).toEqual(expected);
    });

    it("it would pay elsewhere: the MON wouldn't come back to the wallet", async () => {
      const { signed, refused } = await after(
        () =>
          (world.moves = ({ usdc }) => ({
            out: [{ token: USDC, amount: usdc }],
            in: [],
            grants: [],
          })),
      );
      if (mon !== null) expect(String(refused)).toContain("get less into your wallet");
      expect(signed).toEqual(expected);
    });

    it("it would leave a permission behind: an approval the swap doesn't spend", async () => {
      const { signed, refused } = await after(
        () =>
          (world.moves = ({ usdc, brings }) => ({
            out: [{ token: USDC, amount: usdc }],
            in: [{ token: EVM_NATIVE, amount: brings }],
            grants: [{ token: USDC, spender: ROUTER, amount: 1n }],
          })),
      );
      if (mon !== null) expect(String(refused)).toContain("permission over your money");
      expect(signed).toEqual(expected);
    });

    it("the move's own USDC would be spent: what's there no longer covers both", async () => {
      // $0.20 for the buy and the card's quarter: $0.45 leaves the swap out.
      const { signed, refused } = await after(() => (world.usdc = 449_999n));
      if (mon !== null)
        expect(String(refused)).toContain(
          "The $0.25 of USDC its card showed swapping for MON isn't there beside what the move spends, so nothing was sent.",
        );
      expect(signed).toEqual(expected);
    });
  });

  it("signs no second swap on a later run of a card that already swapped", async () => {
    const shown = await card();
    const swapped: KeptTx = { chain: "monad", hash: "0xswap", setup: true, buysFees: "swap" };
    // Still low: the move goes, and nothing is bought again, nor even asked for.
    world.asked = 0;
    expect(await run(shown.details!, [swapped])).toEqual({ signed: MOVE_ALONE, refused: null });
    expect(world.asked).toBe(0);
    // Short of MON for the move itself: nothing is signed, and it says the card bought once.
    world.mon = SHORT;
    const { signed, refused } = await run(shown.details!, [swapped]);
    expect(refused).toBeInstanceOf(FeesUnpaid);
    expect(String(refused)).toContain("a card buys once");
    expect(signed).toEqual(NOTHING);
  });

  it("lets one run make one swap: a second send that buys is refused with nothing signed", async () => {
    const shown = await card();
    const wallets = recordingWallets();
    const handed = await payingFees(
      { details: shown.details!, txs: [] },
      async () => wallets,
      async () => {},
    );
    await handed.sendEvmTransaction(MONAD, calls);
    const again = [{ to: ROUTER, data: "0x", setup: true as const, buysFees: "swap" }];
    await expect(handed.sendEvmTransaction(MONAD, again)).rejects.toThrow(FeesUnpaid);
    expect(wallets.signed.evm).toHaveLength(2);
  });
});

describe("whether a card swaps for the coin", () => {
  it("swaps where the MON the move leaves pays for fewer than three more like it", async () => {
    // 0.74 MON less a buy's 0.17 is 0.57, under the 0.97 three more need on hand.
    expect(await topUpFor(MONAD, 1)).toMatchObject({ amount: 250_000n, usd: 0.25 });
    // 10 MON, as first run asks for, keeps enough.
    world.mon = 10n * MON;
    expect(await topUpFor(MONAD, 1)).toBeNull();
    // ...but not for a card of sixty moves there.
    expect(await topUpFor(MONAD, 60)).toMatchObject({ amount: 250_000n });
  });

  it("swaps nothing where a sponsor pays the fees, the USDC is short, or the MON can't pay for the swap", async () => {
    world.sponsored = true;
    expect(await topUpFor(MONAD, 1)).toBeNull();
    world.sponsored = false;
    world.usdc = 249_999n;
    expect(await topUpFor(MONAD, 1)).toBeNull();
    world.usdc = 500_000n;
    // 0.1 MON is under the 0.121 the swap itself needs on hand.
    world.mon = 10n ** 17n;
    expect(await topUpFor(MONAD, 1)).toBeNull();
    // A wallet with none of the coin can send nothing there, so no swap is even asked for.
    world.mon = 0n;
    world.asked = 0;
    expect(await topUpFor(MONAD, 1)).toBeNull();
    expect(world.asked).toBe(0);
  });

  it("swaps nothing where KyberSwap brings under a fair share of what it costs", async () => {
    world.brings = 13n * MON;
    expect(await topUpFor(MONAD, 1)).toBeNull();
  });

  const leg = (preview: ActionPreview): PreparedLeg => ({
    recipe: { fundedFrom: () => "monad" } as never as Recipe,
    input: {},
    preview,
  });

  it("puts one swap on a card, on its first move on the chain, and only where the card's sums pay for it", async () => {
    const [first, second, elsewhere] = await keepingFees([
      leg(buy),
      leg(buy),
      leg({ ...buy, sends: { chainId: NETWORKS.base.viem.id } }),
    ]);
    // Two moves on Monad, so what they leave is weighed for both.
    expect(first!.preview.details?.feeCoinOn).toBe("monad");
    expect(second!.preview).toBe(buy);
    expect(elsewhere!.preview.details?.feeCoinOn).toBeUndefined();
    // 1.2 MON pays for one buy and the three after it, not for two and three more.
    world.mon = 12n * 10n ** 17n;
    expect((await keepingFees([leg(buy)]))[0]!.preview).toBe(buy);
    expect((await keepingFees([leg(buy), leg(buy)]))[0]!.preview.details?.feeCoinOn).toBe("monad");
    world.mon = 739_554_019n * 10n ** 9n;
    world.unpaid = "monad is $0.05 short of what this spends there";
    const [unpaid] = await keepingFees([leg(buy)]);
    expect(unpaid!.preview).toBe(buy);
  });

  it("buys nothing more for a chain whose coin a move on the card already buys", async () => {
    const buying = withFeeCoin(buy, (await topUpFor(MONAD, 1))!);
    const [kept] = await keepingFees([leg(buying)]);
    expect(kept!.preview).toBe(buying);
  });
});

describe("what a card says of the swap", () => {
  it("says what it comes to, that most of it stays, and the route it goes through", async () => {
    const shown = await card();
    expect(feeCoinsSaid([{ details: shown.details! }])).toBe(
      "Also buys about $0.25 of MON for network fees, most of which stays in your wallet. Bought through KyberSwap.",
    );
  });
});
