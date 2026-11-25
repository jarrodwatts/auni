import { asc } from "drizzle-orm";

import type { Tx } from "../db/client.ts";
import { fills } from "../db/schema.ts";
import { isMargined, isSavings } from "../apps/registry.ts";
import { fillIdentity, QUANTITY_DECIMALS } from "./fill-key.ts";
import type { Flow } from "./flows.ts";
import { unitUsd } from "./format.ts";
import type { Holding, OnItsWay, Portfolio } from "./portfolio.ts";
import {
  centsToUsd,
  formatUnits,
  parseUnits,
  signedUnits,
  signedUsdToCents,
  sumUsd,
  usdToCents,
} from "./usd.ts";

// The books: who holds what by the fills Auni recorded, what a sale or a shared fill leaves
// each thread, and what the fills paid. All pure but for allFills, the one read they start from.

/** A recorded fill, as the books and a thread's budget read it. */
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
 * Positions keyed by `fillIdentity`: a fill with the position (or from none)
 * adds its dollars to that position's cost; a fill against it closes that share
 * of the quantity, releases the same share of the cost, and books the
 * difference as realized, in cents. A fill past zero opens the other way with
 * what is left of it, for a perp; anything else sold past what it held has
 * closed, and the rest is realized.
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

type Owned<T> = T & { readonly threadId: string | null };

/**
 * A money move's fills as its thread owns them. Taking savings out to pay
 * for picks sells only what the thread itself held there; the rest is
 * the owner's own cash changing places, recorded outside the thread
 * (null), so it never reads as a sale, as money taken out, or as a return.
 */
export function ownedMoveFills<T extends PotFill>(
  moved: readonly T[],
  threadId: string,
  /** The thread's recorded fills, oldest first. */
  recorded: readonly PotFill[],
): Owned<T>[] {
  const { positions } = walkPositions(recorded);
  return moved.flatMap((fill): Owned<T>[] => {
    const position = positions.get(fillIdentity(fill));
    const held =
      fill.side === "sell" && position && position.quantity > 0n ? position.quantity : 0n;
    if (!position || held === 0n) return [{ ...fill, threadId: null }];
    const size = parseUnits(fill.quantity, QUANTITY_DECIMALS);
    position.quantity -= held < size ? held : size;
    if (held >= size) return [{ ...fill, threadId }];
    const cents = usdToCents(fill.usdValue);
    const owned = (cents * held) / size;
    return [
      {
        ...fill,
        quantity: formatUnits(held, QUANTITY_DECIMALS),
        usdValue: centsToUsd(owned),
        threadId,
      },
      {
        ...fill,
        quantity: formatUnits(size - held, QUANTITY_DECIMALS),
        usdValue: centsToUsd(cents - owned),
        threadId: null,
      },
    ];
  });
}

/**
 * Whose a sale of `size` units of a holding was, so every thread's books
 * keep matching the wallet whichever thread sells: the thread that sold first,
 * then unattributed holdings (null), then each other thread in order of first
 * fill. What it sold past all they held is the selling place's.
 */
export function saleOwners(
  size: bigint,
  place: string | null,
  /** Who held what it sold just before it sold. */
  held: Holders,
): (readonly [string | null, bigint])[] {
  const own = (owner: string | null) =>
    owner === null ? held.other : (held.threads.find(([id]) => id === owner)?.[1] ?? 0n);
  const order: (readonly [string | null, bigint])[] = [
    [place, own(place)],
    ...(place === null ? [] : [[null, held.other] as const]),
    ...held.threads.filter(([id]) => id !== place),
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
 * A fill shared between threads by weight: its quantity, dollars and what it locked in each in
 * proportion, the last piece taking what rounding leaves, so the pieces add up to it exactly.
 */
export function sharedFill<T extends PotFill & { readonly pnlUsd?: string }>(
  fill: T,
  weights: readonly (readonly [string | null, bigint])[],
): Owned<T>[] {
  if (weights.length === 1) return [{ ...fill, threadId: weights[0]?.[0] ?? null }];
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0n);
  const whole = {
    quantity: parseUnits(fill.quantity, QUANTITY_DECIMALS),
    cents: usdToCents(fill.usdValue),
    pnl: fill.pnlUsd === undefined ? 0n : signedUnits(fill.pnlUsd, PNL_DECIMALS),
  };
  const left = { ...whole };
  return weights.map(([threadId, weight], index) => {
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
      threadId,
    };
  });
}

/** The places a fill's profit or loss is kept to (see fills.pnlUsd). */
export const PNL_DECIMALS = 6;

/** Every fill, oldest first. */
export function allFills(q: Pick<Tx, "select">) {
  return q
    .select({
      threadId: fills.threadId,
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

type BookFill = PotFill & { readonly threadId: string | null; readonly createdAt?: Date };

/**
 * Each thread's net filled quantity of each holding, keyed by `fillIdentity`
 * in QUANTITY_DECIMALS units, ordered by each thread's first fill.
 */
export function threadBooks(
  from: readonly Omit<BookFill, "usdValue">[],
): Map<string, Map<string, bigint>> {
  const books = new Map<string, Map<string, bigint>>();
  for (const fill of from) addToBooks(books, fill);
  return books;
}

/** Adds one more fill, the newest, to threadBooks' books. */
export function addToBooks(
  books: Map<string, Map<string, bigint>>,
  fill: Omit<BookFill, "usdValue">,
): void {
  if (!fill.threadId) return;
  const book = books.get(fill.threadId) ?? new Map<string, bigint>();
  const key = fillIdentity(fill);
  book.set(key, (book.get(key) ?? 0n) + signedQuantity(fill));
  books.set(fill.threadId, book);
}

/** Who holds how much of something: each thread a share, and unattributed holdings the rest. */
interface Holders {
  readonly threads: readonly (readonly [threadId: string, units: bigint])[];
  readonly other: bigint;
}

/**
 * Who holds how much of `total` units of a holding the wallet holds: each
 * thread its books, in order, as far as the wallet goes, and unattributed the
 * rest. A sale's own thread goes `first`, since what it sold is its own before
 * anyone else's. `total` is signed as the books are, so a short is negative;
 * what each holds comes back unsigned.
 */
export function holdersOf(
  total: bigint,
  books: ReadonlyMap<string, ReadonlyMap<string, bigint>>,
  key: string,
  first: string | null = null,
): Holders {
  const sign = total < 0n ? -1n : 1n;
  let remaining = total * sign;
  const threads: (readonly [string, bigint])[] = [];
  const ordered = [...books].sort(([a], [b]) => Number(b === first) - Number(a === first));
  for (const [threadId, book] of ordered) {
    const owned = (book.get(key) ?? 0n) * sign;
    if (owned <= 0n || remaining === 0n) continue;
    const units = owned < remaining ? owned : remaining;
    remaining -= units;
    threads.push([threadId, units]);
  }
  return { threads, other: remaining };
}

/**
 * Who a move's buys belong to, from who owned what it sold: another thread's holding sold
 * buys for that thread, so its books follow it; the owner's own loose holding sold buys for
 * the thread that made the move (`place`), as their loose cash would.
 */
export function buyersOf(
  sellers: readonly (readonly [string | null, bigint])[],
  place: string | null,
): (readonly [string | null, bigint])[] {
  const merged = new Map<string | null, bigint>();
  for (const [owner, units] of sellers) {
    const buyer = owner ?? place;
    merged.set(buyer, (merged.get(buyer) ?? 0n) + units);
  }
  return [...merged];
}

/**
 * Each live holding split among the threads whose fills hold it, in order of each thread's
 * first fill as far as the wallet goes (see holdersOf), and what no thread holds: so the
 * threads' shares and the rest add up to the wallet, to the cent, and every screen gives a
 * thread the same. Each share costs what its own fills paid (see paidFor), never the wallet's
 * average: two takes that bought one stock at $100 and $200 each keep their own price, and
 * the owner's own buys of it change neither. Savings that grew stay with the takes that put
 * them in (see withGrowth), and a perp two takes share gains from each one's own entry (see
 * ownEntries). `at` is when the holdings were read; `sentIn`, the money core recorded coming in
 * from outside Auni (see arrivalFlows in made.ts), which no take holds.
 */
export function holdingsByThread(
  holdings: readonly Holding[],
  everyFill: readonly BookFill[],
  at: Date = new Date(),
  sentIn: readonly Flow[] = [],
): { threads: Map<string, Holding[]>; loose: Holding[] } {
  const books = threadBooks(everyFill);
  const byOwner = Map.groupBy(everyFill, (fill) => fill.threadId);
  const paid = new Map([...byOwner].map(([owner, own]) => [owner, purchases(own)]));
  const threads = new Map<string, Holding[]>();
  const loose: Holding[] = [];
  for (const holding of holdings) {
    const total = parseUnits(holding.quantity, QUANTITY_DECIMALS);
    if (total === 0n) continue;
    const key = fillIdentity(holding);
    const inBooks = holdersOf(holding.short ? -total : total, books, key);
    const putsOf = (owner: string | null): Put[] => [
      ...(byOwner.get(owner) ?? [])
        .filter((fill) => fillIdentity(fill) === key)
        .map((fill) => ({
          units: signedQuantity(fill),
          at: fill.createdAt?.getTime() ?? at.getTime(),
        })),
      ...(owner === null
        ? sentIn
            .filter((flow) => flow.key === key)
            .flatMap((flow) => sentInUnits(holding, flow, total))
        : []),
    ];
    const held = isSavings(holding.venue)
      ? withGrowth(inBooks, holding.decimals, putsOf, at)
      : inBooks;
    const owners = [...held.threads, ...(held.other > 0n ? [[null, held.other] as const] : [])];
    const shares = isMargined(holding)
      ? ownEntries(holding, sharesOf(holding, owners, total), (owner) =>
          owner === null ? undefined : entryOf(byOwner.get(owner) ?? [], key),
        )
      : sharesOf(holding, owners, total).map(
          ([owner, share]) => [owner, paidFor(share, paid.get(owner)?.get(key))] as const,
        );
    for (const [owner, costed] of shares) {
      if (owner === null) loose.push(costed);
      else threads.set(owner, [...(threads.get(owner) ?? []), costed]);
    }
  }
  return { threads, loose };
}

/** Units put into savings (signed, in QUANTITY_DECIMALS units; a withdrawal is negative), and when. */
interface Put {
  readonly units: bigint;
  readonly at: number;
}

/**
 * Savings grow by themselves (aUSDC's balance rises as interest accrues, a dollar each), so the
 * wallet holds more than anything put in. Every unit earns at the same rate, so the growth is
 * shared by what each holder put in times how long it has held it: a take that saved a year ago
 * earned what a take that saved yesterday did not. What no take holds is the owner's own: what
 * their own fills put in, and what core recorded coming in from outside Auni (an exchange's
 * aUSDC, or what was there when Auni first looked), which is never a take's gain.
 */
function withGrowth(
  held: Holders,
  decimals: number,
  putsOf: (owner: string | null) => readonly Put[],
  at: Date,
): Holders {
  if (held.other === 0n || held.threads.length === 0) return held;
  const loose = stake(putsOf(null), at);
  const kept = loose.units < 0n ? 0n : loose.units < held.other ? loose.units : held.other;
  const growth = held.other - kept;
  const weights = [...held.threads.map(([id]) => stake(putsOf(id), at).weight), loose.weight];
  const total = weights.reduce((sum, weight) => sum + weight, 0n);
  if (growth <= 0n || total === 0n) return held;
  // Whole base units of the token, so the shares still add up to the wallet.
  const step = 10n ** BigInt(QUANTITY_DECIMALS - decimals);
  const shares = weights.map((weight) => ((growth * weight) / total / step) * step);
  // What rounding leaves goes to the last take, rather than a crumb nobody holds.
  const last = held.threads.length - 1;
  shares[last] = shares[last]! + growth - shares.reduce((sum, share) => sum + share, 0n);
  const threads = held.threads.map(
    ([threadId, units], index) => [threadId, units + shares[index]!] as const,
  );
  return {
    threads,
    other: held.other - shares.slice(0, -1).reduce((sum, share) => sum + share, 0n),
  };
}

/** What a holder has put in, and that times how long each part has been in, to `at`. */
function stake(puts: readonly Put[], at: Date): { units: bigint; weight: bigint } {
  let units = 0n;
  let weight = 0n;
  for (const put of puts) {
    units += put.units;
    weight += put.units * BigInt(Math.max(0, at.getTime() - put.at));
  }
  return { units, weight: weight > 0n ? weight : 0n };
}

/**
 * Money core recorded coming in from outside as units of `holding`, at its price now, from when
 * it was really there (`since`): what Auni found at its first look earns from then, not from 0.
 */
function sentInUnits(holding: Holding, flow: Flow, total: bigint): Put[] {
  const worth = holding.usdValue === null ? 0n : usdToCents(holding.usdValue);
  if (worth === 0n) return [];
  const units = (BigInt(Math.round(flow.usd * 100)) * total) / worth;
  return [{ units, at: flow.since ?? flow.at }];
}

/** A thread's own entry price into a perp, in dollars to 12 places, by its fills (see walkPositions). */
function entryOf(own: readonly PotFill[], key: string): bigint | undefined {
  const position = walkPositions(own).positions.get(key);
  if (!position || position.quantity === 0n) return undefined;
  return (position.cost * 10n ** 10n * 10n ** BigInt(QUANTITY_DECIMALS)) / abs(position.quantity);
}

/**
 * A perp shared among owners. The venue keeps one position at one blended entry, so each share
 * of what it has made (see sharesOf) moves by how far its owner's own entry sits from the
 * venue's: two takes short at $3,000 and $2,000 with the mark at $2,400 make +$600 and -$400,
 * not +$100 each. What no take holds has no entry of its own, so it takes what the takes' moves
 * leave, and the entry that implies: a take long 1 BTC from $55,000 beside 1 more at a blended
 * $60,000, the mark there too, made $5,000 and the other lost it. With every share a take's, the
 * moves are measured from the blend of their own entries, so they still add to nothing. Each
 * share's value stays its part of the venue's (sharesOf): what closing that part frees, and for
 * a leveraged perp never below nothing, however far its own entry sits.
 */
function ownEntries<Owner>(
  holding: Holding,
  shares: readonly (readonly [Owner, Holding])[],
  entry: (owner: Owner) => bigint | undefined,
): readonly (readonly [Owner, Holding])[] {
  if (shares.length < 2 || !holding.averageCostUsd || holding.unrealizedPnlUsd === undefined) {
    return shares;
  }
  const venue = parseUnits(holding.averageCostUsd, 12);
  const sized = shares.map(([owner, share]) => ({
    owner,
    share,
    units: parseUnits(share.quantity, QUANTITY_DECIMALS),
    entry: entry(owner),
  }));
  const unknown = sized.findLastIndex((share) => share.entry === undefined);
  const from =
    unknown === -1
      ? sized.reduce((sum, share) => sum + share.units * share.entry!, 0n) /
        sized.reduce((sum, { units }) => sum + units, 0n)
      : venue;
  // A long makes more the lower it got in; a short, the higher.
  const sign = holding.short ? -1n : 1n;
  // Units to 18 places times dollars to 12 is cents 28 places further.
  const fine = 10n ** 28n;
  // The share without an entry of its own balances the rest; with none, the last takes what
  // rounding leaves.
  const balancing = unknown === -1 ? sized.length - 1 : unknown;
  const shifts = sized.map(({ units, entry }, index) =>
    index === balancing || entry === undefined ? 0n : (sign * units * (from - entry)) / fine,
  );
  shifts[balancing] = -shifts.reduce((sum, shift) => sum + shift, 0n);
  return sized.map(({ owner, share, units, entry }, index) => {
    const shift = shifts[index]!;
    // The entry a share without its own must have had, for its part of the venue's to add up.
    const implied = venue - (shift * fine) / (sign * units);
    const own = entry ?? (index === balancing && implied > 0n ? implied : venue);
    return [
      owner,
      {
        ...share,
        averageCostUsd: formatUnits(own, 12),
        unrealizedPnlUsd: centsToUsd(signedUsdToCents(share.unrealizedPnlUsd ?? "0") + shift),
      },
    ] as const;
  });
}

/**
 * A holding cut into each owner's `units` of its `total` (both in QUANTITY_DECIMALS units),
 * its value and what it has made in proportion, the last share taking what rounding leaves,
 * so the shares add up to the holding exactly.
 */
function sharesOf<Owner>(
  holding: Holding,
  owners: readonly (readonly [Owner, bigint])[],
  total: bigint,
): [Owner, Holding][] {
  if (owners.length === 1 && owners[0]![1] === total) return [[owners[0]![0], holding]];
  const whole = {
    value: holding.usdValue === null ? null : usdToCents(holding.usdValue),
    made:
      holding.unrealizedPnlUsd === undefined ? null : signedUsdToCents(holding.unrealizedPnlUsd),
  };
  const left = { ...whole };
  return owners.map(([owner, units], index) => {
    const last = index === owners.length - 1;
    const part = (key: keyof typeof whole) => {
      const all = whole[key];
      if (all === null) return null;
      const piece = last ? left[key]! : (all * units) / total;
      left[key] = left[key]! - piece;
      return centsToUsd(piece);
    };
    const value = part("value");
    const made = part("made");
    return [
      owner,
      {
        ...holding,
        quantity: formatUnits(
          units / 10n ** BigInt(QUANTITY_DECIMALS - holding.decimals),
          holding.decimals,
        ),
        usdValue: value,
        ...(made === null ? {} : { unrealizedPnlUsd: made }),
      },
    ];
  });
}

/**
 * A share of a holding with what its owner's own fills paid for it (`book`, see purchases):
 * their average, where they bought at least what the share is; else nothing records its cost.
 * Savings grow by themselves (see withGrowth), so a share of them that holds more than it bought
 * spreads what it paid over all it holds, and what it has made is the interest.
 */
function paidFor(share: Holding, book: { held: bigint; cost: bigint } | undefined): Holding {
  const rest = unpaid(share);
  const units = parseUnits(share.quantity, QUANTITY_DECIMALS);
  if (!book || book.held <= 0n || units === 0n) return rest;
  const grown = book.held < units;
  if (grown && !isSavings(share.venue)) return rest;
  // Its cost is in cents carried 18 places further (FINE_CENTS); the average, in dollars to 12.
  const over = grown ? units : book.held;
  return { ...rest, averageCostUsd: formatUnits((book.cost * 10n ** 10n) / over, 12) };
}

/** A holding with nothing recording what it cost. */
const unpaid = ({ averageCostUsd: _, ...rest }: Holding): Holding => rest;

/**
 * What a holding has made since it was bought, and what it cost, in cents. A perp's gain is
 * what its venue says it has made so far, over the margin its entry put up (its size at the
 * entry price over its leverage); anything else's is its value now less what its units cost at
 * their average. Null when nothing records the cost or the gain, or it has no price now.
 */
export function gainOf(holding: Holding): { costCents: bigint; changeCents: bigint } | null {
  if (!holding.averageCostUsd || holding.usdValue === null) return null;
  const margined = isMargined(holding);
  const made = margined ? holding.unrealizedPnlUsd : undefined;
  if (margined && made === undefined) return null;
  // Units to 18 places times dollars to 12 is cents 28 places further, over the leverage (to
  // three places) for a perp, rounded once to the nearest cent.
  const leverage = margined ? BigInt(Math.round((holding.leverage ?? 1) * 1000)) : 1000n;
  const fine =
    parseUnits(holding.quantity, QUANTITY_DECIMALS) *
    parseUnits(holding.averageCostUsd, 12) *
    1000n;
  const scale = 10n ** 28n * leverage;
  const costCents = (fine + scale / 2n) / scale;
  return {
    costCents,
    changeCents:
      made === undefined ? usdToCents(holding.usdValue) - costCents : signedUsdToCents(made),
  };
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
 * average cost comes from Auni's own fills behind it. Only when they bought at
 * least what is held: one that came partly from elsewhere stays unknown rather
 * than half known.
 */
export function withFillCosts(portfolio: Portfolio, everyFill: readonly PotFill[]): Portfolio {
  const books = purchases(everyFill);
  const costed = portfolio.holdings.map((holding) => {
    if (holding.cash || holding.averageCostUsd) return holding;
    const book = books.get(fillIdentity(holding));
    if (!book || book.held <= 0n) return holding;
    if (parseUnits(holding.quantity, QUANTITY_DECIMALS) > book.held) return holding;
    const units = Number(formatUnits(book.held, QUANTITY_DECIMALS));
    const cents = Number(formatUnits(book.cost, 18));
    return { ...holding, averageCostUsd: unitUsd(cents / 100 / units) };
  });
  const assets = costed.filter((holding) => !holding.cash || holding.heldForOrders);
  const cash = costed.filter((holding) => holding.cash && !holding.heldForOrders);
  return {
    ...portfolio,
    holdings: costed,
    assets: { usdValue: worthUsd(assets), holdings: assets },
    cash: { usdValue: worthUsd(cash), holdings: cash },
  };
}

/** What these holdings are worth together; an unpriced one adds nothing. */
export function worthUsd(holdings: readonly Holding[]): string {
  return sumUsd(holdings.flatMap((holding) => holding.usdValue ?? []));
}

/** Groups what was read into non-cash assets, free Cash, and money on its way. */
export function buildPortfolio(input: {
  observedAt: Date;
  holdings: readonly Holding[];
  onItsWay: readonly OnItsWay[];
  unavailable: readonly string[];
  looking: readonly string[];
}): Portfolio {
  const assets: Holding[] = [];
  const cash: Holding[] = [];
  for (const holding of input.holdings) {
    (holding.cash && !holding.heldForOrders ? cash : assets).push(holding);
  }
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
    assets: { usdValue: worthUsd(assets), holdings: assets },
    cash: { usdValue: worthUsd(cash), holdings: cash },
    onTheWay: { usdValue: onTheWay, moves: input.onItsWay },
  };
}
