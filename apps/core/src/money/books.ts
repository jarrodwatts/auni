import { asc } from "drizzle-orm";

import type { Tx } from "../db/client.ts";
import { fills } from "../db/schema.ts";
import { isMargined } from "../apps/registry.ts";
import { fillIdentity, QUANTITY_DECIMALS } from "./fill-key.ts";
import { unitUsd } from "./format.ts";
import type { Holding, OnItsWay, Portfolio } from "./portfolio.ts";
import { centsToUsd, formatUnits, parseUnits, signedUnits, sumUsd, usdToCents } from "./usd.ts";

// The books: who holds what by the fills Auni recorded, how a read is split between the
// specialists, what a sale or a shared fill leaves each, and what the fills paid. All pure but
// for allFills, the one read they start from.

/** A recorded fill, as the books and a specialist's pot read it. */
export interface PotFill {
  readonly chain: string;
  readonly instrument: string;
  readonly side: "buy" | "sell";
  readonly quantity: string;
  readonly usdValue: string;
}

/** An open position as fills leave it: signed quantity (18 decimals; short below zero) and cost in cents. */
interface Position {
  quantity: bigint;
  cost: bigint;
  perp: boolean;
}

/** A fill's quantity as the walker counts it, signed: a sell is negative. */
export function signedQuantity(fill: Pick<PotFill, "side" | "quantity">): bigint {
  const size = parseUnits(fill.quantity, QUANTITY_DECIMALS);
  return fill.side === "buy" ? size : -size;
}

/**
 * Positions the way the portfolio attributes them, keyed by `fillIdentity`: a
 * fill with the position (or from none) adds its dollars to that position's
 * cost; a fill against it closes that share of the quantity, releases the same
 * share of the cost, and books the difference as realized, in cents. A fill
 * past zero opens the other way with what is left of it, for a perp; anything
 * else sold past what it held has closed, and the rest is realized.
 */
export function walkPositions(fills: readonly PotFill[]): {
  positions: Map<string, Position>;
  realized: bigint;
} {
  const positions = new Map<string, Position>();
  let realized = 0n;
  for (const fill of fills) {
    const key = fillIdentity(fill);
    const position = positions.get(key) ?? {
      quantity: 0n,
      cost: 0n,
      perp: isMargined(fill),
    };
    const signed = signedQuantity(fill);
    const size = abs(signed);
    const value = usdToCents(fill.usdValue);
    if (!position.perp && signed < 0n && position.quantity <= 0n) {
      // Only a perp is ever short: a sale of something not held (savings
      // interest, say) is proceeds, not a position.
      realized += value;
    } else if (position.quantity === 0n || position.quantity > 0n === signed > 0n) {
      position.quantity += signed;
      position.cost += value;
    } else if (size > 0n) {
      const held = abs(position.quantity);
      const closing = size < held ? size : held;
      const released = (position.cost * closing) / held;
      const closingValue = (value * closing) / size;
      // A long closes by selling (value comes back); a short closes by buying (value goes out).
      realized += position.quantity > 0n ? closingValue - released : released - closingValue;
      position.cost -= released;
      position.quantity += signed > 0n ? closing : -closing;
      if (size > closing && position.perp) {
        position.quantity = signed > 0n ? size - closing : closing - size;
        position.cost = value - closingValue;
      } else if (size > closing) {
        realized += value - closingValue;
      }
    }
    positions.set(key, position);
  }
  return { positions, realized };
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

type Owned<T> = T & { readonly specialistId: string | null };

/**
 * A money move's fills as its specialist owns them. Taking savings out to pay
 * for picks sells only what the specialist itself held there; the rest is
 * the owner's own cash changing places, recorded outside the specialist
 * (null), so it never reads as a sale, as money taken out, or as a return.
 */
export function ownedMoveFills<T extends PotFill>(
  moved: readonly T[],
  specialistId: string,
  /** The specialist's recorded fills, oldest first. */
  recorded: readonly PotFill[],
): Owned<T>[] {
  const { positions } = walkPositions(recorded);
  return moved.flatMap((fill): Owned<T>[] => {
    const position = positions.get(fillIdentity(fill));
    const held =
      fill.side === "sell" && position && position.quantity > 0n ? position.quantity : 0n;
    if (!position || held === 0n) return [{ ...fill, specialistId: null }];
    const size = parseUnits(fill.quantity, QUANTITY_DECIMALS);
    position.quantity -= held < size ? held : size;
    if (held >= size) return [{ ...fill, specialistId }];
    const cents = usdToCents(fill.usdValue);
    const owned = (cents * held) / size;
    return [
      {
        ...fill,
        quantity: formatUnits(held, QUANTITY_DECIMALS),
        usdValue: centsToUsd(owned),
        specialistId,
      },
      {
        ...fill,
        quantity: formatUnits(size - held, QUANTITY_DECIMALS),
        usdValue: centsToUsd(cents - owned),
        specialistId: null,
      },
    ];
  });
}

/**
 * Whose a sale of `size` units of a holding was, so every specialist's books
 * keep matching the wallet whichever thread sells: the place that sold first,
 * then Other, then each other specialist as the portfolio orders them. What it
 * sold past all they held is the selling place's, as any oversold sale is.
 */
export function saleOwners(
  size: bigint,
  place: string | null,
  /** Who held what it sold just before it sold. */
  held: Holders,
): (readonly [string | null, bigint])[] {
  const own = (owner: string | null) =>
    owner === null ? held.other : (held.specialists.find(([id]) => id === owner)?.[1] ?? 0n);
  const order: (readonly [string | null, bigint])[] = [
    [place, own(place)],
    ...(place === null ? [] : [[null, held.other] as const]),
    ...held.specialists.filter(([id]) => id !== place),
  ];
  const taken = new Map<string | null, bigint>();
  let left = size;
  for (const [owner, units] of order) {
    const take = units < left ? units : left;
    if (take > 0n) taken.set(owner, (taken.get(owner) ?? 0n) + take);
    left -= take;
  }
  if (left > 0n || taken.size === 0) taken.set(place, (taken.get(place) ?? 0n) + left);
  return [...taken];
}

/**
 * A fill shared between owners by weight: its quantity, dollars and what it locked in each in
 * proportion, the last piece taking what rounding leaves, so the pieces add up to it exactly. A
 * sale is shared by whose units it sold, and what it brought in by the same weights, so a
 * holding swapped for another stays its owner's money rather than reading as cash it got back.
 */
export function sharedFill<T extends PotFill & { readonly pnlUsd?: string }>(
  fill: T,
  weights: readonly (readonly [string | null, bigint])[],
): Owned<T>[] {
  if (weights.length === 1) return [{ ...fill, specialistId: weights[0]?.[0] ?? null }];
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0n);
  const whole = {
    quantity: parseUnits(fill.quantity, QUANTITY_DECIMALS),
    cents: usdToCents(fill.usdValue),
    pnl: fill.pnlUsd === undefined ? 0n : signedUnits(fill.pnlUsd, PNL_DECIMALS),
  };
  const left = { ...whole };
  return weights.map(([specialistId, weight], index) => {
    const last = index === weights.length - 1;
    const part = (key: keyof typeof whole) => {
      const piece = last ? left[key] : (whole[key] * weight) / total;
      left[key] -= piece;
      return piece;
    };
    return {
      ...fill,
      quantity: formatUnits(part("quantity"), QUANTITY_DECIMALS),
      usdValue: centsToUsd(part("cents")),
      ...(fill.pnlUsd === undefined ? {} : { pnlUsd: formatUnits(part("pnl"), PNL_DECIMALS) }),
      specialistId,
    };
  });
}

/** The places a fill's profit or loss is kept to (see fills.pnlUsd). */
export const PNL_DECIMALS = 6;

/**
 * Every fill, oldest first, which is the order attribution reads them in;
 * when each was recorded says how a past reading was split.
 */
export function allFills(q: Pick<Tx, "select">) {
  return q
    .select({
      specialistId: fills.specialistId,
      chain: fills.chain,
      instrument: fills.instrument,
      side: fills.side,
      quantity: fills.quantity,
      usdValue: fills.usdValue,
      createdAt: fills.createdAt,
    })
    .from(fills)
    .orderBy(asc(fills.createdAt), asc(fills.id));
}

type BookFill = Pick<
  PotFill & { specialistId: string | null },
  "specialistId" | "chain" | "instrument" | "side" | "quantity"
>;

/**
 * Each specialist's net filled quantity of each holding, keyed by
 * `fillIdentity` in QUANTITY_DECIMALS units, in the order holdings are split
 * between them: by each one's first fill.
 */
export function specialistBooks(from: readonly BookFill[]): Map<string, Map<string, bigint>> {
  const books = new Map<string, Map<string, bigint>>();
  for (const fill of from) addToBooks(books, fill);
  return books;
}

/** Adds one more fill, the newest, to specialistBooks' books. */
export function addToBooks(books: Map<string, Map<string, bigint>>, fill: BookFill): void {
  if (!fill.specialistId) return;
  const book = books.get(fill.specialistId) ?? new Map<string, bigint>();
  const key = fillIdentity(fill);
  book.set(key, (book.get(key) ?? 0n) + signedQuantity(fill));
  books.set(fill.specialistId, book);
}

/** Who holds how much of something: each specialist a share, and Other the rest. */
interface Holders {
  readonly specialists: readonly (readonly [specialistId: string, units: bigint])[];
  readonly other: bigint;
}

/**
 * Who holds how much of `total` units of a holding the wallet holds: each
 * specialist its books, in order, as far as the wallet goes, and Other the
 * rest. The one rule the portfolio splits a holding by, and a sale is written
 * by; a sale's own specialist goes `first`, since what it sold is its own
 * before anyone else's. `total` is signed as the books are, so a short is
 * negative and held by the specialists whose sells opened it; what each holds
 * comes back unsigned.
 */
export function holdersOf(
  total: bigint,
  books: ReadonlyMap<string, ReadonlyMap<string, bigint>>,
  key: string,
  first: string | null = null,
): Holders {
  const sign = total < 0n ? -1n : 1n;
  let remaining = total * sign;
  const specialists: (readonly [string, bigint])[] = [];
  const ordered = [...books].sort(([a], [b]) => Number(b === first) - Number(a === first));
  for (const [specialistId, book] of ordered) {
    const owned = (book.get(key) ?? 0n) * sign;
    if (owned <= 0n || remaining === 0n) continue;
    const units = owned < remaining ? owned : remaining;
    remaining -= units;
    specialists.push([specialistId, units]);
  }
  return { specialists, other: remaining };
}

/** Something specialists' records say they hold more of than is held (see holdingGaps). */
export interface HoldingGap {
  /** The holding, by fillIdentity. */
  readonly key: string;
  /** What is held, signed as books are (a short below zero), in QUANTITY_DECIMALS units. */
  readonly held: bigint;
  /** What the specialists' records add up to, the same way. */
  readonly recorded: bigint;
}

/**
 * Each holding the specialists' records give them more of than is held, the
 * same way, long or short, on a chain that was read; one held none of at all
 * too. attribute caps each specialist at what is held, so without this a
 * position gone with nothing recorded of it would only quietly shrink, as a
 * liquidated perp long once hid for nine days.
 */
export function holdingGaps(input: {
  holdings: readonly Holding[];
  fills: readonly BookFill[];
  unread: (chain: string) => boolean;
}): HoldingGap[] {
  const books = [...specialistBooks(input.fills).values()];
  const held = new Map<string, bigint>();
  for (const holding of input.holdings) {
    const key = fillIdentity(holding);
    const units = parseUnits(holding.quantity, QUANTITY_DECIMALS);
    held.set(key, (held.get(key) ?? 0n) + (holding.short ? -units : units));
  }
  const filled = new Map(input.fills.map((fill) => [fillIdentity(fill), fill]));
  return [...filled].flatMap(([key, fill]) => {
    const { chain } = fill;
    if (input.unread(chain)) return [];
    const total = held.get(key) ?? 0n;
    // Of something not held, only a perp may be recorded short.
    const ways = total !== 0n ? [total < 0n ? -1n : 1n] : isMargined(fill) ? [1n, -1n] : [1n];
    return ways.flatMap((way) => {
      const recorded = books.reduce((sum, book) => {
        const units = (book.get(key) ?? 0n) * way;
        return units > 0n ? sum + units : sum;
      }, 0n);
      return recorded > total * way ? [{ key, held: total, recorded: recorded * way }] : [];
    });
  });
}

/** Cents carried 18 places further, so the cost left after selling most of something stays exact. */
const FINE_CENTS = 10n ** 18n;

/**
 * What is left of each thing the fills bought, oldest first, and what that
 * part cost: a sale releases its share of the cost, so the average it leaves
 * is unchanged, and a buy blends in at the quantity still held.
 */
function purchases(from: readonly PotFill[]): Map<string, { held: bigint; cost: bigint }> {
  const books = new Map<string, { held: bigint; cost: bigint }>();
  for (const fill of from) {
    const key = fillIdentity(fill);
    const book = books.get(key) ?? { held: 0n, cost: 0n };
    const signed = signedQuantity(fill);
    if (signed > 0n) {
      const open = book.held > 0n ? book : { held: 0n, cost: 0n };
      const cost = open.cost + usdToCents(fill.usdValue) * FINE_CENTS;
      books.set(key, { held: open.held + signed, cost });
    } else if (book.held > 0n) {
      const sold = -signed < book.held ? -signed : book.held;
      books.set(key, {
        held: book.held + signed,
        cost: book.cost - (book.cost * sold) / book.held,
      });
    }
  }
  return books;
}

/**
 * Where the venue keeps no book (coins and stocks in a wallet), a holding's
 * average cost comes from Auni's own fills behind it: a specialist's share
 * from that specialist's fills, the rest from fills outside any specialist,
 * the whole from them all. Only when they bought at least what is held: one
 * that came partly from elsewhere stays unknown rather than half known.
 */
export function withFillCosts(
  portfolio: Portfolio,
  everyFill: readonly (PotFill & { specialistId: string | null })[],
): Portfolio {
  const costed = (holdings: readonly Holding[], from: readonly PotFill[]): Holding[] => {
    const books = purchases(from);
    return holdings.map((holding) => {
      if (holding.cash || holding.averageCostUsd) return holding;
      const book = books.get(fillIdentity(holding));
      if (!book || book.held <= 0n) return holding;
      if (parseUnits(holding.quantity, QUANTITY_DECIMALS) > book.held) return holding;
      const units = Number(formatUnits(book.held, QUANTITY_DECIMALS));
      const cents = Number(formatUnits(book.cost, 18));
      return { ...holding, averageCostUsd: unitUsd(cents / 100 / units) };
    });
  };
  const fillsOf = (specialistId: string | null) =>
    everyFill.filter((fill) => fill.specialistId === specialistId);
  return {
    ...portfolio,
    holdings: costed(portfolio.holdings, everyFill),
    specialists: portfolio.specialists.map((bucket) => ({
      ...bucket,
      holdings: costed(bucket.holdings, fillsOf(bucket.id)),
    })),
    other: { ...portfolio.other, holdings: costed(portfolio.other.holdings, fillsOf(null)) },
  };
}

/** What these holdings are worth together; an unpriced one adds nothing. */
export function worthUsd(holdings: readonly Holding[]): string {
  return sumUsd(holdings.flatMap((holding) => holding.usdValue ?? []));
}

/** Splits what was read between the specialists, Other and Cash (see Holding). */
export function attribute(input: {
  observedAt: Date;
  holdings: readonly Holding[];
  fills: readonly {
    specialistId: string | null;
    chain: string;
    instrument: string;
    side: "buy" | "sell";
    quantity: string;
  }[];
  specialists: readonly { id: string; purpose: string; status: string }[];
  onItsWay: readonly OnItsWay[];
  unavailable: readonly string[];
  looking: readonly string[];
  /** Whether what is held on `chain` may be missing from the read. */
  unread: (chain: string) => boolean;
}): Portfolio {
  const books = specialistBooks(input.fills);

  const buckets = new Map<string, Holding[]>(
    input.specialists.map((specialist) => [specialist.id, []]),
  );
  const other: Holding[] = [];
  const cash: Holding[] = [];
  for (const holding of input.holdings) {
    const total = parseUnits(holding.quantity, QUANTITY_DECIMALS);
    const cents = holding.usdValue === null ? null : usdToCents(holding.usdValue);
    const share = (units: bigint): Holding => ({
      ...holding,
      quantity: formatUnits(
        units / 10n ** BigInt(QUANTITY_DECIMALS - holding.decimals),
        holding.decimals,
      ),
      usdValue: cents === null || total === 0n ? null : centsToUsd((cents * units) / total),
    });
    const holders = holdersOf(holding.short ? -total : total, books, fillIdentity(holding));
    for (const [specialistId, units] of holders.specialists)
      buckets.get(specialistId)?.push(share(units));
    if (holders.other > 0n)
      (holding.cash && !holding.heldForOrders ? cash : other).push(
        holders.other === total ? holding : share(holders.other),
      );
  }

  const specialistBuckets = input.specialists
    .map((specialist) => {
      const holdings = buckets.get(specialist.id) ?? [];
      return {
        id: specialist.id,
        purpose: specialist.purpose,
        status: specialist.status,
        usdValue: worthUsd(holdings),
        holdings,
        // It holds only what it has fills of, so a chain it never filled on can't be short.
        whole: !input.fills.some(
          (fill) => fill.specialistId === specialist.id && input.unread(fill.chain),
        ),
      };
    })
    .filter((bucket) => bucket.status === "active" || bucket.holdings.length > 0);
  const onTheWay = centsToUsd(
    input.onItsWay.reduce((acc, move) => acc + usdToCents(move.usdValue), 0n),
  );
  const totalUsd = centsToUsd(usdToCents(worthUsd(input.holdings)) + usdToCents(onTheWay));
  return {
    observedAt: input.observedAt.toISOString(),
    totalUsd,
    unavailable: input.unavailable,
    looking: input.looking,
    holdings: input.holdings,
    specialists: specialistBuckets,
    other: { usdValue: worthUsd(other), holdings: other },
    cash: { usdValue: worthUsd(cash), holdings: cash },
    onTheWay: { usdValue: onTheWay, moves: input.onItsWay },
  };
}
