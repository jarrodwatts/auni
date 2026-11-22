import { address } from "@solana/kit";
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { WRAPPED_SOL } from "./fill-key.ts";
import type { Signer } from "./recipe.ts";
import type { PayInAnswer, PayInRequest } from "./pay-in.ts";
import { simulateSolana, type SolanaSimulation } from "./solana-effect.ts";
import { FeesUnpaid, NothingMoved } from "./recipe.ts";
import {
  feeCoinCash,
  feeCoinUsd,
  feeCoinsSaid,
  withFeeCoin,
  withoutFeeCoin,
} from "./fee-coin-said.ts";
import { costsLabel, costsTogether } from "./effect.ts";
import {
  outOfWhatItSends,
  solFor,
  solForFees,
  buyingSolOnce,
  topUpSol,
  withTopUp,
  type SolTopUp,
} from "./sol-top-up.ts";
import { SOLANA_USDC } from "./chains.ts";
import type { SolanaQuote } from "../apps/contract.ts";
import { ownGas } from "./gas.ts";
import { paysOwnGas } from "./wallets.ts";

const EVM = "0x000000000000000000000000000000000000dEaD";
const SOLANA = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";

// The app core pays in through: a service called Carry, whose depository takes a deposit of a
// token from a sender. Its answers are held to each request by core's real check (pay-in.ts).
const DEPOSITORY = getAddress("0x00000000000000000000000000000000000de905");
const carryAbi = parseAbi(["function deposit(address from, address token, uint256 amount)"]);
const approval = (spender: Address, amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] });
/** Carry's answer to a request: an approval of its depository, then the deposit, for 0.0104 SOL at least. */
function answer(
  request: PayInRequest,
  approve = approval(DEPOSITORY, request.amount),
): PayInAnswer {
  const step = (id: string, to: string, data: Hex) => ({
    id,
    kind: "transaction",
    requestId: `0x${"ab".repeat(32)}` as Hex,
    calls: [{ chainId: 143, to, data, value: 0n }],
  });
  const deposit = encodeFunctionData({
    abi: carryAbi,
    functionName: "deposit",
    args: [request.user, request.from.token as Address, request.amount],
  });
  return {
    steps: [step("approve", request.from.token, approve), step("deposit", DEPOSITORY, deposit)],
    pays: { recipient: request.recipient, ...request.to },
    out: 10_855_085n,
    least: 10_411_112n,
  };
}
const payIn = vi.hoisted(() => ({ quote: vi.fn(), status: vi.fn() }));

const chain = vi.hoisted(() => ({
  monadUsdc: 5_000_000n,
  solanaUsdc: 5_000_000n,
  solPrice: 100,
  /** The wallet's SOL at each read in turn, the last for every read after. */
  sol: [] as bigint[],
}));
vi.mock(import("./chains.ts"), async (original) => ({
  ...(await original()),
  publicClient: () => ({ readContract: async () => chain.monadUsdc }) as never,
  solanaTokenBalance: async (_owner, mint) =>
    mint === WRAPPED_SOL
      ? chain.sol.length > 1
        ? chain.sol.shift()!
        : chain.sol[0]!
      : chain.solanaUsdc,
}));
vi.mock(import("./wallets.ts"), async (original) => ({
  ...(await original()),
  walletAddresses: async () => ({ evm: EVM, solana: SOLANA }),
  paysOwnGas: vi.fn(async () => true),
}));
vi.mock(import("./gas.ts"), () => ({ ownGas: vi.fn(async () => null), ownGasFees: vi.fn() }));
vi.mock(import("./token-feeds.ts"), async (original) => ({
  ...(await original()),
  solUsd: async () => chain.solPrice,
}));
// The Solana route SOL is bought on, and the app it is paid in through.
const buildSwapTransaction = vi.hoisted(() => vi.fn());
vi.mock(import("../apps/registry.ts"), async (original) => ({
  ...(await original()),
  filling: ((role: string) =>
    role === "payIn"
      ? [
          {
            about: { id: "carry", name: "Carry" },
            part: {
              depository: DEPOSITORY,
              deposit: (data: Hex) => {
                const [depositor, token, amount] = decodeFunctionData({ abi: carryAbi, data }).args;
                return { depositor, token, amount };
              },
              ...payIn,
            },
          },
        ]
      : [
          { about: { id: "route", name: "Route" }, part: { build: buildSwapTransaction } },
        ]) as never,
}));
vi.mock(import("./solana-effect.ts"), async (original) => ({
  ...(await original()),
  simulateSolana: vi.fn(),
}));

const OWNER = address(SOLANA);
/** What a card pins of the SOL it buys: `usdc` of Monad's USDC through Carry, or swapped on Solana. */
const pinned = (usdc: string, how: "pay-in" | "swap" = "pay-in") => ({
  feeCoinOn: "solana",
  feeCoinFrom: how === "swap" ? "solana" : "monad",
  feeCoinToken: how === "swap" ? SOLANA_USDC.mint : MONAD_USDC,
  feeCoinAmount: usdc,
  feeCoinUsd: (Number(usdc) / 1e6).toFixed(2),
  feeCoinBy: how === "swap" ? "Route" : "Carry",
});
const sendSolana = vi.fn(async () => "signature");
const sendEvm = vi.fn(async () => "0xdeposit");
const wallets = {
  evmAddress: EVM,
  solanaAddress: OWNER,
  sendSolanaTransaction: sendSolana,
  sendEvmTransaction: sendEvm,
} as unknown as Signer;
const simulated = (sol: bigint) =>
  ({
    effect: {
      out: [{ token: SOLANA_USDC.mint, amount: 400_000n }],
      in: [{ token: WRAPPED_SOL, amount: sol }],
      grants: [],
    },
  }) as unknown as SolanaSimulation;

// A swap looks its route up in the registry when first asked for, and the first ask loads every
// app: seconds when the whole suite runs at once, which no single test should have to fit in.
beforeAll(async () => void (await import("../apps/registry.ts")), 60_000);

beforeEach(() => {
  vi.clearAllMocks();
  chain.solPrice = 100;
  chain.monadUsdc = 5_000_000n;
  chain.solanaUsdc = 5_000_000n;
  // None, then what the pay-in service brings.
  chain.sol = [0n, 12_993_853n];
  vi.mocked(paysOwnGas).mockResolvedValue(true);
  vi.mocked(ownGas).mockResolvedValue(null);
  payIn.status.mockResolvedValue({ status: "success", paidIn: [] });
  payIn.quote.mockImplementation(async (request: PayInRequest) => answer(request));
  vi.mocked(buildSwapTransaction).mockResolvedValue({
    quote: { minOutAmount: 3_400_000n } as SolanaQuote,
    transactionBase64: "swap",
  });
});

describe("solForFees", () => {
  // 0.0035 SOL at $100 is 35 cents; a dollar is asked for, whose SOL pays later fees too.
  const SHORT = 3_484_720n;

  it("buys a wallet that pays its own way SOL with its USDC on Monad, paid in", async () => {
    const plan = await solForFees(SHORT);
    expect(plan).toMatchObject({ via: "pay-in", usdc: 1_000_000n, quote: { by: "Carry" } });
    expect(payIn.quote).toHaveBeenCalledWith({
      user: EVM,
      recipient: SOLANA,
      from: { chain: "monad", token: MONAD_USDC },
      to: { chain: "solana", token: "native" },
      amount: 1_000_000n,
    });
  });

  it("says plainly what would let it when there's too little USDC on Monad", async () => {
    chain.monadUsdc = 999_999n;
    await expect(solForFees(SHORT)).rejects.toThrow(
      "send a little SOL to their Solana address, or USDC on Monad",
    );
    expect(payIn.quote).not.toHaveBeenCalled();
  });

  it("refuses when the quote's least would bring under what it's short", async () => {
    // At $50 a SOL a dollar is asked for 0.015 SOL, more than the quote's least.
    chain.solPrice = 50;
    await expect(solForFees(15_000_000n)).rejects.toThrow("Carry would bring at least");
  });

  it("refuses when the wallet can't pay for the sends in MON", async () => {
    vi.mocked(ownGas).mockResolvedValue({ short: "Too little MON for gas.", fee: 1n });
    await expect(solForFees(SHORT)).rejects.toThrow("Too little MON for gas.");
  });

  it("refuses a quote whose approval is anyone's but the depository's", async () => {
    payIn.quote.mockImplementation(async (request: PayInRequest) =>
      answer(request, approval(EVM, 1_000_000n)),
    );
    await expect(solForFees(SHORT)).rejects.toThrow("approves something other than");
  });

  it("spends on a card's run exactly the USDC its card showed, and no more", async () => {
    // At $280 a SOL a fresh card would ask for $1.07; this one showed $1, which still buys it.
    chain.solPrice = 280;
    const card = { amountUsd: "0", details: pinned("1000000") };
    expect(await solForFees(SHORT, { approved: card })).toMatchObject({
      via: "pay-in",
      usdc: 1_000_000n,
    });
    expect(payIn.quote).toHaveBeenCalledWith(expect.objectContaining({ amount: 1_000_000n }));
    vi.mocked(paysOwnGas).mockResolvedValue(false);
    expect(await solForFees(SHORT, { approved: card })).toMatchObject({
      via: "swap",
      usdc: 1_000_000n,
    });
  });

  it("buys no SOL on a card's run its card didn't show, or that its USDC no longer buys", async () => {
    const none = { amountUsd: "0", details: {} };
    await expect(solForFees(SHORT, { approved: none })).rejects.toThrow(NothingMoved);
    // Nor one whose card showed buying another chain's coin: that is no SOL.
    const eth = { amountUsd: "0", details: { ...pinned("1000000"), feeCoinOn: "arbitrum" } };
    await expect(solForFees(SHORT, { approved: eth })).rejects.toThrow(
      "its card showed buying none",
    );
    // 0.0035 SOL is 35 cents at $100, and 52 cents at $150: past the card's 40.
    chain.solPrice = 150;
    const card = { amountUsd: "0", details: pinned("400000", "swap") };
    vi.mocked(paysOwnGas).mockResolvedValue(false);
    await expect(solForFees(SHORT, { approved: card })).rejects.toThrow(
      "cost more now than the $0.40 its card showed",
    );
    expect(payIn.quote).not.toHaveBeenCalled();
  });

  it("buys a sponsored wallet SOL with its Solana USDC, beside what the move spends", async () => {
    vi.mocked(paysOwnGas).mockResolvedValue(false);
    expect(await solForFees(SHORT)).toMatchObject({ via: "swap", usdc: 383_320n });
    chain.solanaUsdc = 400_000n;
    await expect(solForFees(SHORT, { spends: 100_000n })).rejects.toThrow(
      "too little USDC on Solana to buy it",
    );
  });
});

describe("solFor", () => {
  it("buys what a transaction Auni built is short, simulated as the wallet pays its own way", async () => {
    vi.mocked(simulateSolana).mockResolvedValue({ short: 3_484_720n } as SolanaSimulation);
    const card = { amountUsd: "0", details: pinned("1000000") };
    expect(await solFor("opening", SOLANA, { approved: card })).toMatchObject({ via: "pay-in" });
    expect(simulateSolana).toHaveBeenCalledWith("opening", OWNER, { paysOwnFee: true });
    vi.mocked(simulateSolana).mockResolvedValue({ short: 0n } as SolanaSimulation);
    expect(await solFor("opening", SOLANA)).toBeNull();
  });

  it("buys none for a wallet whose sponsor pays, without simulating", async () => {
    vi.mocked(paysOwnGas).mockResolvedValue(false);
    expect(await solFor("opening", SOLANA)).toBeNull();
    expect(simulateSolana).not.toHaveBeenCalled();
  });
});

describe("topUpSol", () => {
  /** A sponsored wallet's top-up: 40 cents of its Solana USDC swapped for SOL. */
  const swap: SolTopUp = {
    via: "swap",
    usdc: 400_000n,
    lamports: 3_484_720n,
    spends: 0n,
    bought: {
      chain: "solana",
      from: "solana",
      token: SOLANA_USDC.mint,
      amount: 400_000n,
      usd: 0.4,
      by: "Route",
    },
  };

  it("sends the quote's approval and deposit on Monad as setup, and waits for the SOL", async () => {
    const plan = await solForFees(3_484_720n);
    payIn.status
      .mockResolvedValueOnce({ status: "pending", paidIn: [] })
      .mockResolvedValueOnce({ status: "success", paidIn: [] });
    vi.useFakeTimers();
    try {
      const topUp = topUpSol(wallets, plan);
      await vi.runAllTimersAsync();
      expect(await topUp).toEqual([{ chain: "monad", hash: "0xdeposit", setup: true }]);
    } finally {
      vi.useRealTimers();
    }
    const [approve, deposit] = answer(payIn.quote.mock.calls[0]![0] as PayInRequest).steps;
    // Both calls say they are the card's purchase, by the service's id for the order, so the
    // wallet a move is handed keeps the send as that and lets the card make it once (payingFees).
    const order = `0x${"ab".repeat(32)}`;
    expect(sendEvm).toHaveBeenCalledWith(143, [
      { to: MONAD_USDC, data: approve!.calls[0]!.data, setup: true, buysFees: order },
      { to: DEPOSITORY, data: deposit!.calls[0]!.data, setup: true, buysFees: order },
    ]);
    expect(payIn.status).toHaveBeenCalledTimes(2);
  });

  // As the first live move into Solana did: Relay said it had paid, and the wallet's opening of
  // its USDC account was sent at once, before Solana's node showed the SOL, so its simulation
  // failed for want of it ("This wallet pays its own Solana fees ..., so it needs a little SOL").
  it("goes on only once the SOL shows in the wallet on Solana, after the service says it paid", async () => {
    const plan = await solForFees(3_484_720n);
    chain.sol = [0n, 0n, 0n, 12_993_853n];
    vi.useFakeTimers();
    try {
      let done = false;
      const topUp = topUpSol(wallets, plan).then((txs) => {
        done = true;
        return txs;
      });
      await vi.advanceTimersByTimeAsync(1_500);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await topUp).toEqual([{ chain: "monad", hash: "0xdeposit", setup: true }]);
      expect(chain.sol).toEqual([12_993_853n]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops with nothing more bought when the SOL the service paid hasn't shown in a minute", async () => {
    const plan = await solForFees(3_484_720n);
    chain.sol = [0n];
    vi.useFakeTimers();
    try {
      const waiting = topUpSol(wallets, plan).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(62_000);
      const late = await waiting;
      expect(late).toBeInstanceOf(FeesUnpaid);
      expect((late as Error).message).toContain("Try again once the SOL is there");
    } finally {
      vi.useRealTimers();
    }
    expect(sendEvm).toHaveBeenCalledTimes(1);
    expect(sendSolana).not.toHaveBeenCalled();
  });

  it("stops the move as a purchase that didn't come, saying where the order stands", async () => {
    const plan = await solForFees(3_484_720n);
    payIn.status.mockResolvedValue({ status: "refunded", paidIn: [] });
    const refunded = await topUpSol(wallets, plan).catch((error: unknown) => error);
    expect(refunded).toBeInstanceOf(FeesUnpaid);
    expect((refunded as Error).message).toBe(
      "Carry refunded the $1 of USDC this card sent it from Monad rather than pay the SOL, so the move wasn't sent. Ask Auni for it again: a new card shows what it buys.",
    );
    payIn.status.mockResolvedValue({ status: "failed", paidIn: [] });
    await expect(topUpSol(wallets, plan)).rejects.toThrow("paid no SOL");
  });

  it("stops the same way when the SOL hasn't been brought in 2 minutes: it may come yet", async () => {
    const plan = await solForFees(3_484_720n);
    payIn.status.mockResolvedValue({ status: "pending", paidIn: [] });
    vi.useFakeTimers();
    try {
      const waiting = topUpSol(wallets, plan).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(125_000);
      const late = await waiting;
      // Its USDC went. The card buys once, so the move can run again once the SOL is there.
      expect(late).toBeInstanceOf(FeesUnpaid);
      expect((late as Error).message).toBe(
        "Carry has the $1 of USDC this card sent it from Monad and hasn't paid the SOL yet. It pays or refunds by itself. Try again once the SOL is there: nothing more is bought.",
      );
    } finally {
      vi.useRealTimers();
    }
    expect(sendEvm).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a quote that isn't one approval and one deposit", async () => {
    const plan = (await solForFees(3_484_720n)) as Extract<SolTopUp, { via: "pay-in" }>;
    const twice = { ...plan, quote: { ...plan.quote, steps: [...plan.quote.steps].reverse() } };
    await expect(topUpSol(wallets, twice)).rejects.toThrow("isn't one approval and one deposit");
    expect(sendEvm).not.toHaveBeenCalled();
  });

  // The route builds the swap's bytes, so they go only once a simulation shows them doing what was asked.
  it("buys SOL into a sponsored wallet with the USDC asked, as a setup step", async () => {
    vi.mocked(simulateSolana).mockResolvedValue(simulated(3_450_000n));
    expect(await topUpSol(wallets, swap)).toEqual([
      { chain: "solana", hash: "signature", setup: true },
    ]);
    expect(simulateSolana).toHaveBeenCalledWith("swap", OWNER);
    // Marked as the card's purchase, as the deposit is, so it too is made once.
    expect(sendSolana).toHaveBeenCalledWith("swap", { setup: true, buysFees: "swap" });
  });

  it("sends no swap whose simulation lands less SOL in the wallet than the quote's least", async () => {
    vi.mocked(simulateSolana).mockResolvedValue(simulated(0n));
    await expect(topUpSol(wallets, swap)).rejects.toThrow("get less into your wallet");
    expect(sendSolana).not.toHaveBeenCalled();
  });
});

describe("what a card pins of the SOL it buys", () => {
  /** What a move opening an account is short: 0.00348472 SOL, 35 cents at $100. */
  const SHORT = 3_484_720n;
  // The same pin as the coin an EVM chain's fees are paid in (fee-coin-said.ts), so the same
  // rules read it: every drawing of the card, a specialist's pot, and a plan's sums.
  const move = {
    summary: "Buy $2 of JUP",
    amountUsd: "2",
    effect: { gives: [{ text: "$2 of USDC" }], gets: [{ text: "about 4 JUP" }], grants: [] },
    details: {},
  };
  const topUpDetails = (plan: SolTopUp) => withTopUp(move, plan).details ?? {};
  const said = (plan: SolTopUp) => feeCoinsSaid([{ details: topUpDetails(plan) }]);
  const cash = (plan: SolTopUp) => feeCoinCash(topUpDetails(plan));

  it("is nothing for a move that buys none", () => {
    expect(withTopUp(move, null)).toBe(move);
  });

  // As "Move $1.50 of USDC from Polygon to Solana" did, whose Costs said "$1 Solana network fee"
  // for the dollar of SOL it bought, most of which stays, beside "$0.25 POL for fees" on the
  // same card: the AI told the owner the fees came to more than the stock they would buy.
  it("is on the card as the coin an EVM chain's fees are paid in is: beside the move, never a cost", async () => {
    const card = withTopUp(move, await solForFees(SHORT));
    expect(card.effect).toEqual(move.effect);
    expect(said(await solForFees(SHORT))).toContain("most of which stays in your wallet");
  });

  it("says a dollar of Monad's USDC sent to the pay-in service, and counts it where it is spent", async () => {
    const plan = await solForFees(SHORT);
    expect(topUpDetails(plan)).toEqual(pinned("1000000"));
    expect(said(plan)).toBe("Also buys about $1 of SOL for network fees, most of which stays in your wallet. Bought through Carry.");
    // A dollar beside the card's own amount: in a specialist's pot, and of Monad's cash in a plan.
    expect(feeCoinUsd(topUpDetails(plan))).toBe("1.00");
    expect(cash(plan)).toEqual({ from: "monad", usd: "1.00" });
  });

  it("says a swap of the wallet's Solana USDC, which rests on nobody, and counts it on Solana", async () => {
    vi.mocked(paysOwnGas).mockResolvedValue(false);
    const plan = await solForFees(SHORT);
    expect(topUpDetails(plan)).toEqual(pinned("383320", "swap"));
    expect(said(plan)).toBe("Also buys about $0.38 of SOL for network fees, most of which stays in your wallet. Bought through Route.");
    expect(feeCoinUsd(topUpDetails(plan))).toBe("0.38");
    expect(cash(plan)).toEqual({ from: "solana", usd: "0.38" });
  });

  it("counts nothing beside the amount of a move that buys its SOL out of what it sends, and still says it", async () => {
    vi.mocked(paysOwnGas).mockResolvedValue(false);
    const plan = outOfWhatItSends(await solForFees(SHORT));
    expect(said(plan)).toBe("Also buys about $0.38 of SOL for network fees, most of which stays in your wallet. Bought through Route.");
    expect(feeCoinUsd(topUpDetails(plan))).toBeNull();
    expect(cash(plan)).toBeNull();
  });

  it("says a plan's total across both ways of buying", async () => {
    const paidIn = { details: topUpDetails(await solForFees(SHORT)) };
    vi.mocked(paysOwnGas).mockResolvedValue(false);
    const swapped = { details: topUpDetails(await solForFees(SHORT)) };
    expect(feeCoinsSaid([paidIn, swapped])).toBe(
"Also buys about $1.38 of SOL for network fees, most of which stays in your wallet. Bought through Carry and Route.",
    );
  });
});

// As "buy 1 dollar of palantir" did once its cash could come from other chains on the same card:
// the bridge into Solana and the buy there each bought a dollar of SOL, for "$2 SOL for fees",
// and the AI said "The card lists SOL at $1 twice".
describe("a card buys SOL once", () => {
  const move = (summary: string) => ({
    summary,
    amountUsd: "1",
    effect: { gives: [{ text: "$1 of USDC" }], gets: [], grants: [], costs: [] },
    details: { chain: "solana" },
  });
  /** Opening the wallet's USDC account, then a buy opening its stock's: each short from no SOL. */
  const OPENS = 2_694_520n;
  const BUYS = 2_214_800n;
  const leg = async (summary: string, stage: number, lamports: bigint, spends = 0n) => ({
    stage,
    preview: withTopUp(move(summary), await solForFees(lamports, { spends })),
  });

  it("buys it on the leg that runs first, for every leg after it, and none on those", async () => {
    const bridge = await leg("Move $1.10 to Solana", 1, OPENS);
    const buy = await leg("Buy $1 of Palantir", 3, BUYS);
    const [first, later] = await buyingSolOnce([bridge, buy], ({ stage }) => stage);
    // A dollar of Monad's USDC through Carry buys 0.0104 SOL at least, enough for both.
    expect(payIn.quote).toHaveBeenLastCalledWith(expect.objectContaining({ amount: 1_000_000n }));
    expect(first!.preview.details).toMatchObject({ chain: "solana", ...pinned("1000000") });
    expect(first!.preview.effect.costs).toEqual([]);
    // Sized for both, once; each keeps what it needs itself, so the card can be weighed again.
    expect(payIn.quote).toHaveBeenCalledTimes(3);
    expect(first!.preview.buysSol).toEqual({ lamports: OPENS, spends: 0n });
    // The buy pins none, so it counts nothing in a plan's sums, and its card says nothing of it.
    expect(later!.preview.details).toEqual({ chain: "solana" });
    expect(later!.preview.effect.costs).toEqual([]);
    expect(later!.preview.buysSol).toEqual({ lamports: BUYS, spends: 0n });
    // Run once the bridge has bought it, the buy finds what it needs there. Should it still be
    // short, it buys nothing and sends nothing: its card showed buying none.
    const card = { amountUsd: "1", details: later!.preview.details! };
    await expect(solForFees(BUYS, { approved: card })).rejects.toThrow(NothingMoved);
    expect(payIn.quote).toHaveBeenCalledTimes(3);
    expect(
      feeCoinsSaid([first!.preview, later!.preview].map(({ details }) => ({ details: details! }))),
    ).toBe(
"Also buys about $1 of SOL for network fees, most of which stays in your wallet. Bought through Carry.",
    );
  });

  it("sizes it for them all where no least amount covers both", async () => {
    // A sponsored wallet swaps its Solana USDC for just what it needs, a tenth over, at $100.
    vi.mocked(paysOwnGas).mockResolvedValue(false);
    const bridge = await leg("Move $1.10 to Solana", 1, OPENS);
    const buy = await leg("Buy $1 of Palantir", 3, BUYS, 1_000_000n);
    const [first] = await buyingSolOnce([bridge, buy], ({ stage }) => stage);
    expect(pinnedOf(first!)).toMatchObject({
      amount: BigInt(Math.ceil((Number(OPENS + BUYS) / 1e9) * 100 * 1.1 * 1e6)),
    });
    // The buy's own USDC still counts against what the swap for SOL can spend.
    chain.solanaUsdc = 1_500_000n;
    const [kept] = await buyingSolOnce([bridge, buy], ({ stage }) => stage);
    expect(kept).toBe(bridge);
  });

  it("leaves a card with one move as it is", async () => {
    const one = await leg("Buy $1 of Palantir", 3, BUYS);
    expect(await buyingSolOnce([one], ({ stage }) => stage)).toEqual([one]);
  });

  // As "buy 1 dollar of palantir" did once more on the merged branch: two bridges into Solana
  // side by side, the first buying ETH for Base's fee as well, then the buy. The first's SOL had
  // given way to its ETH, the other two each bought a dollar of SOL, and the card's costs said
  // "$3 SOL for fees" where its note said "up to $2.25 in all". Its two coins are no cost, as
  // what the fees don't use stays, but the cash they spend still counts where it leaves.
  it("buys it on a move beside others in its stage that buys no other coin, run ahead of them", async () => {
    const eth = {
      chain: "base" as const,
      from: "monad" as const,
      token: MONAD_USDC,
      amount: 250_000n,
      usd: 0.25,
      by: "Carry",
    };
    const base = await leg("Move $0.99 from Base to Solana", 1, OPENS);
    const fromBase = {
      ...base,
      preview: { ...withFeeCoin(withoutFeeCoin(base.preview), eth) },
    };
    const fromArbitrum = await leg("Move $0.30 from Arbitrum to Solana", 1, OPENS);
    const buy = await leg("Buy $1 of Palantir", 3, BUYS);
    const [first, second, third] = await buyingSolOnce(
      [fromBase, fromArbitrum, buy],
      ({ stage }) => stage,
    );
    // Base keeps its ETH, and nothing of SOL.
    expect(first!.preview.details).toMatchObject({ feeCoinOn: "base", feeCoinUsd: "0.25" });
    expect(first!.preview.effect.costs).toEqual([]);
    // Arbitrum's buys SOL for all three, once, and runs ahead of Base's.
    expect(second!.preview.details).toMatchObject({ ...pinned("1000000"), feeCoinAhead: "yes" });
    expect(second!.preview.buysSol).toEqual({ lamports: OPENS, spends: 0n });
    expect(third!.preview.details).toEqual({ chain: "solana" });
    // The card's costs leave both coins out, its note says the $1.25 they come to, and the cash
    // it is checked for counts that $1.25 of Monad's USDC beside its moves.
    const previews = [first!, second!, third!].map(({ preview }) => preview);
    expect(costsLabel(costsTogether(previews.map(({ effect }) => effect)))).toBeNull();
    expect(feeCoinsSaid(previews.map(({ details }) => ({ details: details! })))).toBe(
"Also buys about $1.25 of ETH and SOL for network fees, most of which stays in your wallet. Bought through Carry.",
    );
    expect(previews.map(({ details }) => feeCoinCash(details!))).toEqual([
      { from: "monad", usd: "0.25" },
      { from: "monad", usd: "1.00" },
      null,
    ]);
    // Weighed again, as once the moves paying for it are on, it buys the same, once; and a card
    // that loses the move buying it has the next one buy it for what is left.
    const again = await buyingSolOnce([first!, second!, third!], ({ stage }) => stage);
    expect(again.map(({ preview }) => preview.details)).toEqual(
      previews.map(({ details }) => details),
    );
    const [alone] = await buyingSolOnce([third!], ({ stage }) => stage);
    expect(alone!.preview.details).toMatchObject(pinned("1000000"));
  });

  it("makes no card where the move that needs SOL first buys another coin and none beside it can buy SOL", async () => {
    const eth = {
      chain: "base" as const,
      from: "monad" as const,
      token: MONAD_USDC,
      amount: 250_000n,
      usd: 0.25,
      by: "Carry",
    };
    const base = await leg("Move $0.99 from Base to Solana", 1, OPENS);
    const fromBase = { ...base, preview: withFeeCoin(withoutFeeCoin(base.preview), eth) };
    const buy = await leg("Buy $1 of Palantir", 3, BUYS);
    await expect(buyingSolOnce([fromBase, buy], ({ stage }) => stage)).rejects.toThrow(
      '"Move $0.99 from Base to Solana" buys ETH on Base for its network fee and also needs SOL for Solana\'s',
    );
    await expect(buyingSolOnce([fromBase], ({ stage }) => stage)).rejects.toThrow(
      "a move buys one coin for its fees",
    );
  });
});

const pinnedOf = ({
  preview,
}: {
  readonly preview: { readonly details?: Record<string, string> };
}) => {
  const { feeCoinAmount } = preview.details ?? {};
  return { amount: feeCoinAmount ? BigInt(feeCoinAmount) : null };
};
