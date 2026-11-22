import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { prepareLegs, type PreparedLeg } from "./actions.ts";
import { APPROVED_PROCEEDS } from "./approved.ts";
import { evmTokenKey, fillIdentity, solanaMintKey } from "./fill-key.ts";
import {
  cheapestFirst,
  conversionLegs,
  payableHoldings,
  payingHoldings,
  payingMoves,
  paysWithLines,
  unitsFor,
  type Explained,
  type Payable,
  type Preparing,
} from "./pay-with-holdings.ts";
import { firstBridge } from "../apps/registry.ts";
import type { Holding } from "./portfolio.ts";
import type { FundingChain } from "./recipe.ts";
import { asConversion, convertToCash } from "./recipes/convert.ts";
import { toolRecipe } from "./recipes/index.ts";
import type { Grant } from "./effect.ts";
import { toBaseUnits } from "./swaps/shared.ts";
import { formatUnits } from "./usd.ts";

const ETH = 10n ** 18n;
const USDT = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";

function holding(overrides: Partial<Holding>): Holding {
  return {
    venue: "wallet",
    chain: "base",
    instrument: "native",
    symbol: "ETH",
    quantity: "0.1",
    decimals: 18,
    usdValue: "300.00",
    cash: false,
    priceId: "coingecko:ethereum",
    ...overrides,
  };
}

/** Quantities in the 18 decimals history is weighed in, by holding. */
function explained(
  bought: [Holding, string][] = [],
  deposited: [Holding, string][] = [],
): Explained {
  const units = (entries: [Holding, string][]) =>
    new Map(
      entries.map(([of, whole]) => [fillIdentity(of), BigInt(Number(whole) * 1e6) * 10n ** 12n]),
    );
  return { bought: units(bought), deposited: units(deposited) };
}

const eth = holding({});

describe("payableHoldings", () => {
  it("offers a token that came in as a deposit, all of it", () => {
    expect(payableHoldings([eth], explained([], [[eth, "0.1"]]))).toEqual([
      {
        chain: "base",
        instrument: "native",
        symbol: "ETH",
        decimals: 18,
        units: ETH / 10n,
        cents: 30_000n,
        stable: false,
      },
    ]);
  });

  it("never offers what Auni bought loose: that was meant to stay", () => {
    const more = holding({ quantity: "0.15", usdValue: "450.00" });
    expect(payableHoldings([more], explained([[more, "0.05"]], [[more, "0.1"]]))[0]?.units).toBe(
      ETH / 10n,
    );
    expect(payableHoldings([more], explained([[more, "0.15"]]))).toEqual([]);
  });

  it("offers no more than is held now, however much came in", () => {
    const left = holding({ quantity: "0.04", usdValue: "120.00" });
    expect(payableHoldings([left], explained([], [[left, "0.1"]]))[0]).toMatchObject({
      units: (ETH * 4n) / 100n,
      cents: 12_000n,
    });
  });

  it("offers a stablecoin whole, however it came", () => {
    const usdt = holding({
      chain: "arbitrum",
      instrument: USDT,
      symbol: "USDT",
      quantity: "50",
      decimals: 6,
      usdValue: "49.98",
    });
    expect(payableHoldings([usdt], explained())).toEqual([
      expect.objectContaining({ units: 50_000_000n, stable: true }),
    ]);
    // A token calling itself USDT that isn't worth a dollar is no stablecoin.
    const fake = { ...usdt, usdValue: "5.00" };
    expect(payableHoldings([fake], explained())).toEqual([]);
  });

  it("offers exactly the holdings the owner named, bought or not", () => {
    const jup = holding({
      chain: "solana",
      instrument: JUP,
      symbol: "JUP",
      quantity: "100",
      decimals: 6,
      usdValue: "60.00",
    });
    const named = [solanaMintKey(JUP)];
    expect(
      payableHoldings([eth, jup], explained([[jup, "100"]], [[eth, "0.1"]]), { named }),
    ).toEqual([expect.objectContaining({ chain: "solana", instrument: JUP, units: 100_000_000n })]);
  });

  it("offers none of what the card's own legs sell: one holding never pays twice", () => {
    const deposit = explained([], [[eth, "0.1"]]);
    const selling = (quantity: string) => [{ ...evmTokenKey("base", "native"), quantity }];
    expect(payableHoldings([eth], deposit, { selling: selling("0.04") })[0]).toMatchObject({
      units: (ETH * 6n) / 100n,
      cents: 18_000n,
    });
    expect(payableHoldings([eth], deposit, { selling: selling("0.1") })).toEqual([]);
  });

  it("keeps Monad's reserve of MON, which the wallet can never spend", () => {
    const mon = holding({
      chain: "monad",
      symbol: "MON",
      quantity: "15",
      usdValue: "6.00",
    });
    expect(payableHoldings([mon], explained([], [[mon, "15"]]))[0]).toMatchObject({
      units: 5n * ETH,
      cents: 200n,
    });
  });

  it("offers nothing off Auni's networks, unpriced, dust, cash, or outside the wallet", () => {
    const offered = (one: Holding) => payableHoldings([one], explained([], [[one, "0.1"]]));
    expect(offered(holding({ chain: "eip155:1" }))).toEqual([]);
    expect(offered(holding({ usdValue: null }))).toEqual([]);
    expect(offered(holding({ usdValue: "0.99" }))).toEqual([]);
    expect(offered(holding({ instrument: "0xusdc", symbol: "USDC", cash: true }))).toEqual([]);
    expect(offered(holding({ venue: "aave" }))).toEqual([]);
  });
});

const payable = (overrides: Partial<Payable>): Payable => ({
  chain: "base",
  instrument: "native",
  symbol: "ETH",
  decimals: 18,
  units: ETH,
  cents: 300_000n,
  stable: false,
  ...overrides,
});

describe("unitsFor", () => {
  it("converts just enough for what it covers, with 3% to spare for fees and slippage", () => {
    // $100 of ETH at $3,000 is 0.0333…; 3% more is 0.034333….
    expect(unitsFor(payable({}), 10_000n)).toBe(34_333_333_333_333_300n);
  });

  it("never converts more than may be", () => {
    expect(unitsFor(payable({}), 400_000n)).toBe(ETH);
  });

  it("converts an amount a swap's number carries exactly, so all MON may sell never passes Monad's reserve", () => {
    // 25.123456789012345678 MON with 10 kept back: a float of all 15.12… rounds a few wei up.
    const mon = payable({ chain: "monad", units: 15_123_456_789_012_345_678n, cents: 600n });
    const units = unitsFor(mon, 10_000n);
    expect(units).toBe(15_123_456_789_012_300_000n);
    expect(toBaseUnits(Number(formatUnits(units, 18)), 18)).toBe(units);
    // A conversion refuses an amount its swap's number would round.
    const parses = (amount: string) =>
      z.object(convertToCash.input).safeParse({ chain: "monad", token: "native", amount }).success;
    expect(parses("15.123456789012345678")).toBe(false);
    expect([parses("15.1234567890123"), parses("0.000000000000000012"), parses("2500")]).toEqual([
      true,
      true,
      true,
    ]);
  });
});

describe("cheapestFirst", () => {
  it("prefers what's already where the cash is needed, then stablecoins, then the largest", () => {
    const usdt = payable({ chain: "arbitrum", instrument: USDT, stable: true, cents: 5_000n });
    const small = payable({ chain: "monad", instrument: "0xsmall", cents: 2_000n });
    const big = payable({ chain: "arbitrum", instrument: "0xbig", cents: 90_000n });
    const here = payable({ chain: "monad", instrument: "0xhere", cents: 1_000n, stable: true });
    expect(cheapestFirst([big, small, usdt, here], "monad").map((each) => each.instrument)).toEqual(
      ["0xhere", "0xsmall", USDT, "0xbig"],
    );
  });
});

/** A conversion priced to land `landsUsd` at least, as asConversion counts it. */
function converted(holding: Payable, units: bigint, landsUsd: string): PreparedLeg {
  return {
    recipe: convertToCash,
    input: { chain: holding.chain, token: holding.instrument, amount: String(units) },
    preview: {
      summary: "Convert",
      amountUsd: landsUsd,
      effect: { gives: [], gets: [], grants: [] },
      details: { sell: `${units} ${holding.symbol}`, returnsUsd: landsUsd, feeUsd: "0.50" },
    },
  };
}

function bridged(from: string, to: string, usd: string): PreparedLeg {
  return {
    recipe: firstBridge().bridge.recipe,
    input: { from_chain: from, to_chain: to, amount: usd },
    preview: { summary: "Move", amountUsd: usd, effect: { gives: [], gets: [], grants: [] } },
  };
}

/** Converting lands what it's sized to cover, by `lands`, or throws for a holding that can't go. */
function preparing(lands: (holding: Payable, units: bigint) => string): Preparing {
  return {
    convert: vi.fn(async (holding: Payable, units: bigint) =>
      converted(holding, units, lands(holding, units)),
    ),
    bridge: vi.fn(async (from, to, usd) => bridged(from, to, usd)),
  };
}

const buy = (draws: FundingChain, amountUsd: string) => ({ draws, lands: null, amountUsd });

/** Lands what the units are worth, 2% under: about what a fill lands at least. */
const fair = (holding: Payable, units: bigint) =>
  ((Number((holding.cents * units) / holding.units) / 100) * 0.98).toFixed(2);

describe("conversionLegs", () => {
  it("converts nothing when the cash is there", async () => {
    const prepare = preparing(fair);
    const legs = await conversionLegs(
      [buy("base", "50")],
      new Map([["base", 5_000n]]),
      [payable({})],
      prepare,
    );
    expect(legs).toEqual([]);
    expect(prepare.convert).not.toHaveBeenCalled();
  });

  it("converts just enough where the picks buy, and stops once it's covered", async () => {
    const prepare = preparing(fair);
    const other = payable({ instrument: "0xother" });
    const legs = await conversionLegs(
      [buy("base", "150")],
      new Map([["base", 5_000n]]),
      [payable({}), other],
      prepare,
    );
    expect(payingMoves(legs).map((leg) => leg.recipe.tool)).toEqual(["convert_to_cash"]);
    expect(prepare.convert).toHaveBeenCalledWith(
      payable({}),
      unitsFor(payable({}), 10_000n),
      "base",
    );
  });

  it("bridges what it converts elsewhere on to where the picks buy, enough more that the least it lands covers them", async () => {
    const prepare = preparing(fair);
    const legs = await conversionLegs(
      [buy("monad", "100")],
      new Map([
        ["monad", 0n],
        ["base", 0n],
      ]),
      [payable({})],
      prepare,
    );
    expect(payingMoves(legs).map((leg) => leg.recipe.tool)).toEqual([
      "convert_to_cash",
      "bridge_usdc",
    ]);
    // A bridge of $103.10 lands at least $100 on Monad (all but 3%).
    expect(prepare.convert).toHaveBeenCalledWith(
      payable({}),
      unitsFor(payable({}), 10_310n),
      "monad",
    );
    expect(prepare.bridge).toHaveBeenCalledWith("base", "monad", "103.10");
  });

  it("carries a holding from where cash isn't spent straight to where the picks buy, in one move", async () => {
    const away = payable({ chain: "ink" });
    const prepare = preparing(fair);
    const legs = await conversionLegs(
      [buy("base", "100")],
      new Map([["base", 0n]]),
      [away],
      prepare,
    );
    // No bridge after it, so no fee allowance either: the move itself lands what it covers.
    expect(legs).toHaveLength(1);
    expect(legs[0]!.bridge).toBeNull();
    expect(prepare.convert).toHaveBeenCalledWith(away, unitsFor(away, 10_000n), "base");
    expect(prepare.bridge).not.toHaveBeenCalled();
  });

  it("leaves what a thin fill doesn't land for the next holding", async () => {
    const thin = payable({ instrument: "0xthin", cents: 4_000n, units: 4n * ETH, stable: true });
    const prepare = preparing((holding, units) =>
      holding === thin ? "39.00" : fair(holding, units),
    );
    const legs = await conversionLegs(
      [buy("base", "100")],
      new Map([["base", 0n]]),
      [payable({}), thin],
      prepare,
    );
    expect(legs).toHaveLength(2);
    // The stablecoin went first, all of it, and the ETH covered the $61 it left.
    expect(prepare.convert).toHaveBeenNthCalledWith(1, thin, thin.units, "base");
    expect(prepare.convert).toHaveBeenNthCalledWith(
      2,
      payable({}),
      unitsFor(payable({}), 6_100n),
      "base",
    );
  });

  it("sizes a conversion its route lands short once more by what that route lands, rather than converting another", async () => {
    // 3.5% under the portfolio's price: a venue's fee, a thin market, and both slippages.
    const prepare = preparing((holding, units) =>
      ((Number((holding.cents * units) / holding.units) / 100) * 0.965).toFixed(2),
    );
    const legs = await conversionLegs(
      [buy("base", "250")],
      new Map([["base", 0n]]),
      [payable({}), payable({ instrument: "0xother" })],
      prepare,
    );
    expect(legs).toHaveLength(1);
    expect(Number(legs[0]!.conversion.preview.amountUsd)).toBeGreaterThanOrEqual(250);
    expect(vi.mocked(prepare.convert).mock.calls.map(([holding]) => holding.instrument)).toEqual([
      "native",
      "native",
    ]);
  });

  it("passes over a holding that can't be converted, and leaves the rest short for the card", async () => {
    const stuck = payable({ instrument: "0xstuck", cents: 900_000n });
    const prepare = preparing(fair);
    vi.mocked(prepare.convert).mockRejectedValueOnce(new Error("no route"));
    const small = payable({ cents: 2_000n, units: ETH / 100n });
    const legs = await conversionLegs(
      [buy("base", "100")],
      new Map([["base", 0n]]),
      [stuck, small],
      prepare,
    );
    expect(legs.map((leg) => leg.conversion.input.token)).toEqual(["native"]);
    expect(prepare.convert).toHaveBeenLastCalledWith(small, small.units, "base");
  });
});

describe("paysWithLines", () => {
  const conversion = converted(payable({}), 0n, "101.50");
  const sold = {
    ...conversion,
    preview: {
      ...conversion.preview,
      details: { ...conversion.preview.details, sell: "0.034 ETH" },
    },
  };

  it("says what it sells, what that comes to, and its fee", () => {
    expect(paysWithLines([{ conversion: sold, bridge: null }], [sold])).toEqual([
      "0.034 ETH on Base → about $101.50 USDC, fee $0.50",
    ]);
  });

  it("says a fee too small to reach a cent as under one, not $0 or a rounded-up cent", () => {
    const small = {
      ...sold,
      preview: { ...sold.preview, details: { ...sold.preview.details, feeUsd: "0.004" } },
    };
    expect(paysWithLines([{ conversion: small, bridge: null }], [small])).toEqual([
      "0.034 ETH on Base → about $101.50 USDC, fee under $0.01",
    ]);
  });

  it("names what its own bridge carries on, and where, whatever else the card bridges", () => {
    const claudes = bridged("base", "solana", "40.00");
    const onward = bridged("base", "monad", "101.00");
    const legs = [claudes, sold, onward];
    expect(paysWithLines([{ conversion: sold, bridge: onward }], legs)).toEqual([
      "0.034 ETH on Base → about $101.50 USDC, fee $0.50, $101 of it moved to Monad",
    ]);
    // A payment landing on Base took that bridge's place, so the USDC stays there.
    expect(paysWithLines([{ conversion: sold, bridge: onward }], [claudes, sold])).toEqual([
      "0.034 ETH on Base → about $101.50 USDC, fee $0.50",
    ]);
  });

  it("says nothing for a card paid with cash alone", () => {
    expect(paysWithLines([], [bridged("base", "monad", "5.00")])).toEqual([]);
  });
});

describe("asConversion", () => {
  const swap = {
    summary: "Swap 0.034 ETH (about $102) for about 101.5 USDC on Base",
    amountUsd: "0",
    effect: { gives: [], gets: [], grants: [] },
    details: {
      sell: "0.034 ETH",
      returnsUsd: "101.50",
      feeUsd: "0.51",
      [APPROVED_PROCEEDS]: "100.485",
    },
    sells: { ...evmTokenKey("base", "native"), quantity: "0.034" },
  };

  // It is that swap, so its card says what the swap gives, gets and costs.
  it("counts only the least USDC it can land, a slippage under what its card says at least", () => {
    expect(asConversion("base", swap)).toMatchObject({
      summary: "Convert 0.034 ETH on Base to about $101.50 of USDC",
      amountUsd: "99.48",
      effect: swap.effect,
      sells: swap.sells,
    });
  });

  it("refuses a conversion that loses past its venue's limit the moment it fills", () => {
    expect(() => asConversion("base", { ...swap, unpriced: "loses on fill" })).toThrow(
      "would lose too much the moment it fills",
    );
  });
});

describe("prepareLegs", () => {
  it("takes no conversion the agent puts on a card: only code chooses what pays", async () => {
    const leg = {
      tool: convertToCash.tool,
      input: { chain: "solana", token: "native", amount: "1" },
      label: "convert",
    };
    expect(await prepareLegs([leg])).toEqual({
      prepared: [],
      problems: ["Leg 1 (convert): convert_to_cash is not a money tool."],
    });
  });

  // A card's one Allow carries no proof for a leg, so a move that can need one never rides on it: here
  // a supply whose card also lets someone spend the wallet's USDC.
  it("takes no leg that can need the owner's proof, which one tap can't vouch for", async () => {
    const recipe = toolRecipe("aave_supply")!;
    const savings = {
      tool: recipe.tool,
      input: { chain: "base", amount_usd: "50" },
      label: "savings",
    };
    const preview = (grants: Grant[]) => ({
      summary: "Put $50 into savings on Base",
      amountUsd: "50",
      effect: {
        gives: [{ text: "$50 of USDC on Base" }],
        gets: [{ text: "$50 in savings" }],
        grants,
      },
    });
    vi.spyOn(recipe, "describe").mockResolvedValueOnce(preview([]));
    expect((await prepareLegs([savings])).problems).toEqual([]);
    vi.spyOn(recipe, "describe").mockResolvedValueOnce(
      preview([{ lets: "0x1a2b…9f8e spend your USDC", reach: "wallet" }]),
    );
    expect(await prepareLegs([savings])).toEqual({
      prepared: [],
      problems: [
        "Leg 1 (savings): This one's card can also check it's the owner, so it is its own card: call aave_supply on its own.",
      ],
    });
  });
});

describe("payingHoldings", () => {
  /** A pick priced to spend `amountUsd` of the cash on `chain`. */
  const buying = (chain: FundingChain, amountUsd: string): PreparedLeg => ({
    recipe: { ...convertToCash, readies: undefined, fundedFrom: () => chain },
    input: {},
    preview: { summary: "Buy", amountUsd, effect: { gives: [], gets: [], grants: [] } },
  });
  const cash = (spendable: [FundingChain, bigint][]) => ({
    spendable: new Map(spendable),
    sendable: new Map(spendable),
  });

  it("converts nothing while the owner's own cash elsewhere can be bridged over: that comes first", async () => {
    const short = cash([
      ["monad", 0n],
      ["base", 40_000n],
    ]);
    await expect(payingHoldings([buying("monad", "100")], short)).rejects.toThrow(
      "Monad holds $0 of cash, and it spends $100 there: $100 short. They have cash to spare on other chains, which comes before anything they hold. Add a bridge_usdc leg moving $103.10 from base to monad, and propose again.",
    );
    // Even when they'd rather add money than pay with what they hold.
    await expect(payingHoldings([buying("monad", "100")], short, [])).rejects.toThrow(
      "bridge_usdc",
    );
  });

  it("asks nothing of a card its cash covers", async () => {
    const legs = [buying("monad", "100")];
    expect(await payingHoldings(legs, cash([["monad", 10_000n]]))).toEqual([]);
  });
});
