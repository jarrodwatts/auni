import { CASH_KEYS, isCash, NETWORK_KEYS, NETWORKS, type NetworkKey } from "@auni/shared";
import { and, eq, gt, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/client.ts";
import { actions, arrivals, fills } from "../db/schema.ts";
import { firstBridge } from "../apps/registry.ts";
import { plannedCash, prepareLeg, type PreparedLeg } from "./actions.ts";
import { chainName, RESERVES } from "./chains.ts";
import { fillIdentity, QUANTITY_DECIMALS, tokenKey, type FillKey } from "./fill-key.ts";
import { bridgeLands, bridgesFor, largestShortfall, sendFor, shortfallSaid } from "./funding.ts";
import { readPortfolioShared, type Holding } from "./portfolio.ts";
import type { FundingChain, Sale } from "./recipe.ts";
import { convertToCash, floatExact } from "./recipes/convert.ts";
import type { StagedLeg } from "./proposal-order.ts";
import { feeLabel } from "./format.ts";
import { dollars } from "./summaries.ts";
import { centsToUsd, formatUnits, parseUnits, usdToCents } from "./usd.ts";

/**
 * Hold, convert lazily: money that arrives as a token other than USDC stays
 * that token until a card needs it. When a card's picks need more cash than
 * is where they buy, once the owner's own USDC elsewhere is bridged over, the
 * card converts just enough of what they hold to USDC, and says so; whatever
 * is still short, the card asks them to add. Nothing converts until the tap:
 *
 *   tap → convert where it sits → bridge to where the picks buy → picks
 *
 * A conversion is a move that frees cash, like savings coming out, so it runs
 * first (see proposal-order.ts). One that fails stops the legs its cash was
 * for, and the money stays the token; a bridge after it that fails leaves it as USDC
 * where it was converted. A card never spends more than it showed, since each
 * conversion counts only the least USDC it can land.
 *
 * What a card offers by default is what came in as a deposit and no buy of
 * Auni's explains, and dollar stablecoins anywhere: a coin bought on purpose
 * is often meant to stay loose, so it pays only when the owner names it. What
 * a specialist holds never pays: that is the specialist's.
 */

/** A holding a card may convert, and how much of it. */
export interface Payable extends FillKey {
  readonly chain: NetworkKey;
  readonly symbol: string;
  readonly decimals: number;
  /** What may be converted, in the holding's base units. */
  readonly units: bigint;
  /** What that much is worth, in cents. */
  readonly cents: bigint;
  /** A dollar stablecoin, which converts for almost nothing. */
  readonly stable: boolean;
}

/** What explains a loose holding, by fillIdentity, in QUANTITY_DECIMALS units. */
export interface Explained {
  /**
   * Everything Auni's buys outside any specialist got. No sale cancels one: a
   * coin sold and later bought again, or moved into a specialist and bought
   * loose again, was still bought on purpose.
   */
  readonly bought: ReadonlyMap<string, bigint>;
  /** Everything that came in as a deposit with a price. */
  readonly deposited: ReadonlyMap<string, bigint>;
}

/**
 * The least a holding must be worth for a card to offer it: a dollar, which
 * only leaves out dust, and $25 on Ethereum, where gas costs dollars whoever
 * pays it, which moving less would mostly spend.
 */
function smallestCents(chain: NetworkKey): bigint {
  return chain === "ethereum" ? 2_500n : 100n;
}

/** Dollar stablecoins by symbol, counted only while priced near a dollar. */
const STABLECOINS = new Set([
  "USDC",
  "USDC.E",
  "USDT",
  "USDT0",
  "DAI",
  "USDS",
  "USDG",
  "PYUSD",
  "AUSD",
  "FDUSD",
]);

/**
 * How much more than it covers a conversion sells, in percent: its fill can
 * land a slippage under a quote that may itself be a slippage under the
 * card's (see asConversion), and the price it's sized by isn't the route's.
 */
const MARGIN_PCT = 3n;

/** A card shows at most this many moves, and its payment may need one bridge from every other chain cash is spent on. */
const ROOM = 11 - (CASH_KEYS.length - 1);

/** Within 2% of a dollar a unit. */
function nearDollar(cents: bigint, units: bigint, decimals: number): boolean {
  const atPar = units * 100n;
  const worth = cents * 10n ** BigInt(decimals);
  const off = worth > atPar ? worth - atPar : atPar - worth;
  return off * 50n <= atPar;
}

/**
 * What of each holding no specialist holds (`loose`, the portfolio's Other) a
 * card may convert. With `named`, exactly those the owner asked to pay with;
 * otherwise stablecoins whole, and of anything else the part that came in as
 * a deposit, less what Auni's own loose buys explain. Only priced holdings in
 * a wallet on a network Auni lists, worth at least its smallest, and never a
 * chain's reserve of its own coin, nor what the card's own legs are `selling`:
 * those run after its conversions, and would find it gone.
 */
export function payableHoldings(
  loose: readonly Holding[],
  explained: Explained,
  {
    named,
    selling = [],
  }: { readonly named?: readonly FillKey[]; readonly selling?: readonly Sale[] } = {},
): Payable[] {
  const wanted = named && new Set(named.map(fillIdentity));
  return loose.flatMap((holding): Payable[] => {
    if (holding.venue !== "wallet" || holding.cash || holding.usdValue === null) return [];
    if (!(holding.chain in NETWORKS)) return [];
    const chain = holding.chain as NetworkKey;
    const key = fillIdentity(holding);
    const total = parseUnits(holding.quantity, holding.decimals);
    const worth = usdToCents(holding.usdValue);
    if (total === 0n || worth === 0n) return [];
    const stable =
      STABLECOINS.has(holding.symbol.toUpperCase()) && nearDollar(worth, total, holding.decimals);
    let units: bigint;
    if (wanted) units = wanted.has(key) ? total : 0n;
    else if (stable) units = total;
    else {
      const scale = 10n ** BigInt(QUANTITY_DECIMALS - holding.decimals);
      const unexplained = total * scale - (explained.bought.get(key) ?? 0n);
      const deposited = explained.deposited.get(key) ?? 0n;
      units = (unexplained < deposited ? unexplained : deposited) / scale;
    }
    const reserve =
      holding.instrument === "native" && chain !== "solana" ? (RESERVES[chain] ?? 0n) : 0n;
    const sold = selling
      .filter((sale) => fillIdentity(sale) === key)
      .reduce((sum, sale) => sum + parseUnits(sale.quantity, holding.decimals), 0n);
    if (units > total - reserve - sold) units = total - reserve - sold;
    if (units <= 0n) return [];
    const cents = (worth * units) / total;
    if (cents < smallestCents(chain)) return [];
    return [
      {
        chain,
        instrument: holding.instrument,
        symbol: holding.symbol,
        decimals: holding.decimals,
        units,
        cents,
        stable,
      },
    ];
  });
}

/**
 * Base units of a holding to convert so it covers `cents` with MARGIN_PCT to
 * spare, never more than may be, even once a swap takes it as a number.
 */
export function unitsFor(holding: Payable, cents: bigint): bigint {
  const scaled = holding.units * cents * (100n + MARGIN_PCT);
  const whole = holding.cents * 100n;
  const units = (scaled + whole - 1n) / whole;
  return floatExact(units < holding.units ? units : holding.units);
}

/**
 * Cheapest to convert first, for cash needed on `chain`: one already there
 * needs no bridge, a stablecoin trades at a dollar, and a larger one covers
 * more in fewer moves.
 */
export function cheapestFirst(holdings: readonly Payable[], chain: FundingChain): Payable[] {
  const elsewhere = (holding: Payable) => Number(holding.chain !== chain);
  return holdings.toSorted(
    (a, b) =>
      elsewhere(a) - elsewhere(b) ||
      Number(b.stable) - Number(a.stable) ||
      (b.cents > a.cents ? 1 : b.cents < a.cents ? -1 : 0),
  );
}

/**
 * How a plan's conversion and the bridge after it are checked and priced. A
 * holding where Auni spends cash converts there, landing on `to` only when
 * that's its own chain; one anywhere else goes home to `to` in that one move.
 */
export interface Preparing {
  convert(holding: Payable, units: bigint, to: FundingChain): Promise<PreparedLeg>;
  bridge(from: NetworkKey, to: FundingChain, usd: string): Promise<PreparedLeg>;
}

/** How much more than it covers a conversion re-sized by its own route sells, for that route moving. */
const RESIZED_MARGIN_PCT = 1n;

/**
 * A conversion of `holding` landing at least `covers` cents if it can. It's
 * sized by the portfolio's price, so a route that lands it short, by more
 * than MARGIN_PCT allows for, prices it once more, sized by what that route
 * landed, keeping the first when the second can't go.
 */
async function convertEnough(
  holding: Payable,
  covers: bigint,
  to: FundingChain,
  preparing: Preparing,
): Promise<PreparedLeg> {
  const units = unitsFor(holding, covers);
  const first = await preparing.convert(holding, units, to);
  const lands = usdToCents(first.preview.amountUsd);
  if (lands >= covers || lands <= 0n || units >= holding.units) return first;
  const scaled = units * covers * (100n + RESIZED_MARGIN_PCT);
  const wanted = (scaled + lands * 100n - 1n) / (lands * 100n);
  const resized = floatExact(wanted < holding.units ? wanted : holding.units);
  return preparing.convert(holding, resized, to).catch(() => first);
}

type Planned = Pick<StagedLeg, "draws" | "lands" | "amountUsd" | "landsAtLeastUsd">;

/** A holding converted to pay for a card, and the bridge carrying its USDC on, when one does. */
export interface Paying {
  readonly conversion: PreparedLeg;
  readonly bridge: PreparedLeg | null;
}

/** The moves a card's payings put on it, each conversion before its bridge. */
export function payingMoves(paying: readonly Paying[]): PreparedLeg[] {
  return paying.flatMap(({ conversion, bridge }) => (bridge ? [conversion, bridge] : [conversion]));
}

/**
 * What pays a plan's shortfall with what the owner holds: for the place short
 * by the most, the cheapest holding left converts enough to cover it, and
 * when it sits elsewhere a bridge carries that over, a fee allowance more,
 * until nothing is short or nothing is left. A holding that can't be
 * converted or moved is passed over. Each conversion counts only what it
 * lands at least, so one filling thin leaves the rest short, for the next
 * holding or the card's payment.
 */
export async function conversionLegs(
  legs: readonly Planned[],
  held: ReadonlyMap<FundingChain, bigint>,
  payable: readonly Payable[],
  preparing: Preparing,
): Promise<Paying[]> {
  const added: Paying[] = [];
  let left = [...payable];
  let room = ROOM - legs.filter((leg) => leg.lands).length;
  for (;;) {
    const short = largestShortfall([...legs, ...payingMoves(added).map(plannedCash)], held);
    const [holding, ...rest] = short ? cheapestFirst(left, short.chain) : [];
    if (!short || !holding) return added;
    left = rest;
    // Away from where Auni spends cash, the conversion itself carries it home.
    const bridged = isCash(holding.chain) && holding.chain !== short.chain;
    if (room < (bridged ? 2 : 1)) continue;
    const needs = usdToCents(short.needUsd, "up");
    const covers = bridged ? sendFor(needs, holding.chain as FundingChain) : needs;
    try {
      const conversion = await convertEnough(holding, covers, short.chain, preparing);
      const lands = usdToCents(conversion.preview.amountUsd);
      const sends = lands < covers ? lands : covers;
      if (bridged && bridgeLands(sends, holding.chain as FundingChain) === 0n) continue;
      const bridge = bridged
        ? await preparing.bridge(holding.chain, short.chain, centsToUsd(sends))
        : null;
      added.push({ conversion, bridge });
      room -= bridge ? 2 : 1;
    } catch (error) {
      console.warn(`${holding.symbol} on ${holding.chain} can't pay for a card`, error);
    }
  }
}

/**
 * What a card says before the tap for each holding it converts: "0.081 ETH
 * on Base → about $252 USDC, fee $1.27, $250 of it moved to Monad",
 * naming what its bridge carries on while the card `keeps` that bridge.
 */
export function paysWithLines(paying: readonly Paying[], keeps: readonly PreparedLeg[]): string[] {
  return paying.flatMap(({ conversion, bridge }) => {
    // A conversion sells on its own chain; one going home sells as it leaves.
    const { chain, from_chain: from, to_chain: home } = conversion.input;
    const { sell, returnsUsd, feeUsd } = conversion.preview.details ?? {};
    if (!sell || !returnsUsd) return [];
    const on = chainName((chain ?? from) as NetworkKey);
    const landing = home ? ` on ${chainName(home as NetworkKey)}` : "";
    const fee = feeUsd ? `, fee ${feeLabel(Number(feeUsd))}` : "";
    const onward =
      bridge && keeps.includes(bridge)
        ? `, ${dollars(String(bridge.input.amount))} of it moved to ${chainName(bridge.input.to_chain as NetworkKey)}`
        : "";
    return [`${sell} on ${on} → about ${dollars(returnsUsd)} USDC${landing}${fee}${onward}`];
  });
}

/** What the agent is told a card pays with, so it can say so; null for one paid with cash alone. */
export function paysWithNote(lines: readonly string[]): string | null {
  return lines.length === 0
    ? null
    : `Cash alone doesn't cover it, so it pays with ${lines.join("; ")}: the card shows that, and nothing converts until they tap. Say so in a sentence.`;
}

/** The holdings a card was told to pay with, as a proposing tool takes them. */
export const payWithInput = z
  .array(
    z.object({
      chain: z.enum(NETWORK_KEYS),
      token: z
        .string()
        .min(1)
        .describe(
          'The holding\'s instrument as get_portfolio lists it: an address, a mint, or "native".',
        ),
    }),
  )
  .max(4)
  .optional()
  .describe(
    "Which holdings pay for what cash doesn't cover, converted to USDC only once the owner taps. Leave it out for what came in as deposits and any stablecoins; name coins they bought only when they ask to pay with them; [] when they'd rather add money.",
  );

export type PayWith = NonNullable<z.infer<typeof payWithInput>>[number];

/**
 * The conversions, and bridges after them, that pay for what a card's
 * `prepared` legs need beyond the owner's cash (see walletCash), from what
 * they hold that those legs don't sell (see payableHoldings), or only from
 * those `payWith` names: an empty list pays with none. None when holdings
 * can't be read. Their own cash comes first: while a bridge
 * could bring some from another chain, this refuses the card for the agent,
 * naming the bridges to add, so every card pays in the same order whichever
 * tool proposed it.
 */
export async function payingHoldings(
  context: { readonly specialistId: string | null },
  prepared: readonly PreparedLeg[],
  cash: {
    readonly spendable: ReadonlyMap<FundingChain, bigint>;
    readonly sendable: ReadonlyMap<FundingChain, bigint>;
  },
  payWith?: readonly PayWith[],
): Promise<Paying[]> {
  const legs = prepared.map(plannedCash);
  const short = largestShortfall(legs, cash.spendable);
  if (!short) return [];
  const bridges = bridgesFor(short, legs, cash.sendable);
  const { recipe, input } = firstBridge().bridge;
  if (bridges)
    throw new Error(
      `Nothing was recorded, and the owner saw nothing: ${shortfallSaid(legs, cash.spendable)}. They have cash to spare on other chains, which comes before anything they hold. Add ${bridges.map(({ from, usd }) => `a ${recipe.tool} leg moving $${usd} from ${from}`).join(" and ")} to ${short.chain}, and propose again.`,
    );
  if (payWith?.length === 0) return [];
  let payable: Payable[];
  try {
    const [portfolio, explained] = await Promise.all([readPortfolioShared(), explainedHoldings()]);
    payable = payableHoldings(portfolio.other.holdings, explained, {
      ...(payWith ? { named: payWith.map(({ chain, token }) => tokenKey(chain, token)) } : {}),
      selling: prepared.flatMap(({ preview }) => (preview.sells ? [preview.sells] : [])),
    });
  } catch (error) {
    console.warn("holdings unreadable to pay for a card", error);
    return [];
  }
  return conversionLegs(legs, cash.spendable, payable, {
    convert: (holding, units, to) => {
      const amount = formatUnits(units, holding.decimals);
      if (isCash(holding.chain))
        return prepareLeg(
          convertToCash,
          { chain: holding.chain, token: holding.instrument, amount },
          context,
        );
      return prepareLeg(
        recipe,
        input({ from: holding.chain, to, amount, token: holding.instrument }),
        context,
      );
    },
    bridge: (from, to, usd) => prepareLeg(recipe, input({ from, to, amount: usd }), context),
  });
}

/** What explains the loose holdings (see Explained), read from the fills and arrivals. */
export async function explainedHoldings(): Promise<Explained> {
  const [buys, deposits] = await Promise.all([
    db
      .select({ chain: fills.chain, instrument: fills.instrument, quantity: fills.quantity })
      .from(fills)
      .innerJoin(actions, eq(actions.id, fills.actionId))
      .where(and(isNull(fills.specialistId), eq(fills.side, "buy"))),
    db
      .select({
        chain: arrivals.chain,
        instrument: arrivals.instrument,
        baseUnits: arrivals.baseUnits,
        decimals: arrivals.decimals,
      })
      .from(arrivals)
      .where(
        and(
          eq(arrivals.kind, "deposit"),
          gt(arrivals.baseUnits, "0"),
          isNotNull(arrivals.usdValue),
        ),
      ),
  ]);
  const bought = new Map<string, bigint>();
  for (const { quantity, ...key } of buys)
    bought.set(
      fillIdentity(key),
      (bought.get(fillIdentity(key)) ?? 0n) + parseUnits(quantity, QUANTITY_DECIMALS),
    );
  const deposited = new Map<string, bigint>();
  for (const { baseUnits, decimals, ...key } of deposits) {
    const units = BigInt(baseUnits) * 10n ** BigInt(QUANTITY_DECIMALS - decimals);
    deposited.set(fillIdentity(key), (deposited.get(fillIdentity(key)) ?? 0n) + units);
  }
  return { bought, deposited };
}
