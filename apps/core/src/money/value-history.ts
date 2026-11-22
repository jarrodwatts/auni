import type { ValueHistoryWire, ValueRange } from "@auni/shared";
import { and, asc, desc, eq, gte, isNotNull, isNull, lt, min, ne, sql } from "drizzle-orm";

import { theOwner } from "../auth/owner.ts";
import { db } from "../db/client.ts";
import { valueSnapshots } from "../db/schema.ts";
import { fillIdentity, QUANTITY_DECIMALS } from "./fill-key.ts";
import type { Flow } from "./flows.ts";
import {
  movedUsd,
  perpSize,
  priceAt,
  priceKey,
  readPaths,
  type PerpSize,
  type PricePoint,
  type Step,
} from "./history.ts";
import { specialistFlows, madeUsd, unpricedOf, walletFlows } from "./made.ts";
import { type ReadingHolding } from "./portfolio.ts";
import { addToBooks, allFills, holdersOf } from "./books.ts";
import { centsToUsd, parseUnits } from "./usd.ts";

/**
 * Value over time, like a stocks app: what is held is measured at each
 * reading (money/portfolio.ts saveReading), and between readings it is moved
 * by what shared prices did (money/history.ts). Today and the week are drawn
 * that way; a month and longer are the readings themselves, one a day.
 */

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A reading as a line is drawn from it, of the total or of one specialist. */
export interface Reading {
  readonly at: number;
  /** What it was worth. */
  readonly usd: number;
  /** The plain cash within it (money/made.ts); a specialist holds none. */
  readonly cashUsd: number;
  /** What it held of each holding with a price to move it by; the rest holds its value. */
  readonly held: readonly Held[];
  /** What it held with no price, by fillIdentity, which is in no value (see madeUsd). */
  readonly unpriced?: ReadonlySet<string>;
}

interface Held {
  /** Its price key (see priceKey). */
  readonly key: string;
  readonly usd: number;
  readonly perp: PerpSize | null;
  /** The price the reading valued it at, which its moves count from; null on a reading that didn't keep it. */
  readonly from: number | null;
}

/** One point of a line. */
interface ValuePoint {
  readonly at: number;
  readonly usdValue: string;
  readonly madeUsd: string;
}

/**
 * A gap between a reading and what the estimate before it said, under which
 * it is spread across the interval: price feeds and the venues round and lag
 * each other by about this much.
 */
function smallGap(valueUsd: number): number {
  return Math.max(1, Math.abs(valueUsd) / 100);
}

/**
 * Value at each of `times` (ascending): the last reading at or before it,
 * each holding moved by what its price did since (see movedUsd). When the
 * next reading lands, what it had made differs from what the estimate said
 * by a gap: under max($1, 1%) it is spread evenly across the interval, so the
 * line meets the reading without a jump; a bigger one is left as a step and
 * told to `onGap`. Only what was made is spread: money put in or taken out (a
 * deposit, or cash a trade turned into a holding) steps where the reading
 * finds it. Each point's madeUsd counts money moved in (see walletFlows) up
 * to its reading, which is what it holds. A time before the first reading
 * has no point.
 */
export function valueSeries(input: {
  readonly readings: readonly Reading[];
  readonly times: readonly number[];
  readonly paths: ReadonlyMap<string, readonly PricePoint[]>;
  readonly flows: readonly Flow[];
  readonly onGap?: (reading: Reading, gapUsd: number) => void;
}): ValuePoint[] {
  const { readings, paths, flows } = input;
  const estimate = (reading: Reading, at: number) =>
    reading.held.reduce((usd, held) => {
      const path = paths.get(held.key) ?? [];
      // A price from before the reading is already in what it was read at: it holds until a later one.
      const later = (path.findLast((point) => point.at <= at)?.at ?? -Infinity) > reading.at;
      const moved = movedUsd(
        held.usd,
        held.perp,
        held.from ?? priceAt(path, reading.at),
        held.from === null || later ? priceAt(path, at) : held.from,
      );
      return usd + moved - held.usd;
    }, reading.usd);
  const made = (reading: Reading, usd: number) =>
    Number(madeUsd(usd, reading.cashUsd, flows, reading.at, reading.unpriced));
  const spread = readings.map((reading, index) => {
    const next = readings[index + 1];
    if (!next) return 0;
    const gap = made(next, next.usd) - made(reading, estimate(reading, next.at));
    // A trade's fee or spread belongs to the trade: spread back, it would show before it happened.
    const traded = flows.some((flow) => flow.at > reading.at && flow.at <= next.at);
    if (Math.abs(gap) < smallGap(next.usd)) return traded ? 0 : gap;
    input.onGap?.(next, gap);
    return 0;
  });
  let index = -1;
  return input.times.flatMap((at) => {
    while (index + 1 < readings.length && readings[index + 1]!.at <= at) index += 1;
    const reading = readings[index];
    if (!reading) return [];
    const next = readings[index + 1];
    const share = next ? (at - reading.at) / (next.at - reading.at) : 0;
    const usd = estimate(reading, at) + spread[index]! * share;
    const usdValue = centsToUsd(BigInt(Math.round(usd * 100)));
    const made = madeUsd(Number(usdValue), reading.cashUsd, flows, reading.at, reading.unpriced);
    return [{ at, usdValue, madeUsd: made }];
  });
}

/**
 * Whether Postgres names this time zone: it reads each day at it, and its
 * zones are not quite the ones Intl knows, so one only Intl knows would fail
 * every query that reads their day.
 */
export async function postgresKnowsZone(zone: string): Promise<boolean> {
  const rows = await db.execute(sql`select 1 from pg_timezone_names where name = ${zone}`);
  return rows.length > 0;
}

/**
 * The instant the day `at` falls in began in `timeZone`: the person's own
 * midnight, through any change of the clocks since. A day whose midnight the
 * clocks skip begins when they land.
 */
export function startOfDay(timeZone: string, at = Date.now()): number {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  /** How far their clock reads ahead of UTC at `instant`. */
  const offset = (instant: number) => {
    const part = Object.fromEntries(
      format.formatToParts(instant).map((entry) => [entry.type, Number(entry.value)]),
    );
    const wall = Date.UTC(
      part.year!,
      part.month! - 1,
      part.day,
      part.hour,
      part.minute,
      part.second,
    );
    return wall - Math.floor(instant / 1_000) * 1_000;
  };
  const wall = at + offset(at);
  const midnight = wall - (((wall % DAY_MS) + DAY_MS) % DAY_MS);
  // The offset their clock kept at midnight, which a change of the clocks since makes not today's.
  return midnight - offset(midnight - offset(at));
}

interface TotalRow {
  readonly takenAt: Date;
  readonly usdValue: string;
  readonly cashUsd: string | null;
  readonly holdings: readonly ReadingHolding[] | null;
}

type FillRow = Awaited<ReturnType<typeof allFills>>[number];

/**
 * The readings a line is drawn from: one specialist's, or the total's that
 * kept what they held. A total read before then can't be moved by prices,
 * split between specialists or say what it had made, so each line, its move
 * and the periods offered start at the same reading.
 */
function readingsOf(specialistId: string | null) {
  return specialistId
    ? eq(valueSnapshots.specialistId, specialistId)
    : and(isNull(valueSnapshots.specialistId), isNotNull(valueSnapshots.holdings));
}

/** The total's readings from `from` on, and the last before it, oldest first. */
async function totalReadings(from: number): Promise<TotalRow[]> {
  const columns = {
    takenAt: valueSnapshots.takenAt,
    usdValue: valueSnapshots.usdValue,
    cashUsd: valueSnapshots.cashUsd,
    holdings: valueSnapshots.holdings,
  };
  const kept = readingsOf(null);
  const [before, since] = await Promise.all([
    db
      .select(columns)
      .from(valueSnapshots)
      .where(and(kept, lt(valueSnapshots.takenAt, new Date(from))))
      .orderBy(desc(valueSnapshots.takenAt))
      .limit(1),
    db
      .select(columns)
      .from(valueSnapshots)
      .where(and(kept, gte(valueSnapshots.takenAt, new Date(from))))
      .orderBy(asc(valueSnapshots.takenAt)),
  ]);
  return [...before, ...since];
}

/** A reading of the total, with each specialist's share of each holding in it. */
interface SplitReading {
  readonly row: TotalRow;
  /** By holding, in the reading's order: each specialist's share of it, from 0 to 1. */
  readonly shares: readonly ReadonlyMap<string, number>[];
}

/**
 * The total's readings, each holding split between specialists by their
 * fills recorded by then, the one rule the portfolio splits holdings by (see
 * holdersOf). A reading is kept only once every move before it is recorded,
 * so this is the split it was read with; specialist rows keep no holdings,
 * and a share of the total's value would move a specialist with holdings it
 * never had. Readings and fills are both oldest first, so the books are
 * built once, adding each fill as the readings pass it.
 */
function splitReadings(totals: readonly TotalRow[], userFills: readonly FillRow[]): SplitReading[] {
  const books = new Map<string, Map<string, bigint>>();
  let added = 0;
  return totals.map((row) => {
    for (; added < userFills.length && userFills[added]!.createdAt <= row.takenAt; added += 1)
      addToBooks(books, userFills[added]!);
    const shares = (row.holdings ?? []).map((holding) => {
      const total = parseUnits(holding.quantity, QUANTITY_DECIMALS);
      const { specialists } = holdersOf(
        holding.short ? -total : total,
        books,
        fillIdentity(holding),
      );
      return new Map(
        total > 0n ? specialists.map(([id, units]) => [id, Number(units) / Number(total)]) : [],
      );
    });
    return { row, shares };
  });
}

/** The readings as the total (null), or as one specialist's share of each holding. */
function readingsAs(split: readonly SplitReading[], specialistId: string | null): Reading[] {
  return split.map(({ row, shares }) => {
    const parts = (row.holdings ?? []).map((holding, index) => ({
      holding,
      share: specialistId ? (shares[index]!.get(specialistId) ?? 0) : 1,
    }));
    const held = parts.flatMap(({ holding, share }): Held[] => {
      const key = priceKey(holding);
      if (!key || share === 0 || holding.usdValue === null) return [];
      return [
        {
          key,
          usd: Number(holding.usdValue) * share,
          perp: perpSize(holding, share),
          from: holding.price ?? null,
        },
      ];
    });
    return {
      at: row.takenAt.getTime(),
      usd: specialistId
        ? parts.reduce((sum, { holding, share }) => sum + Number(holding.usdValue ?? 0) * share, 0)
        : Number(row.usdValue),
      cashUsd: specialistId ? 0 : Number(row.cashUsd ?? 0),
      held,
      unpriced: unpricedOf(parts.flatMap(({ holding, share }) => (share > 0 ? [holding] : []))),
    };
  });
}

function pathKeys(readings: readonly Reading[]): string[] {
  return readings.flatMap((reading) => reading.held.map((held) => held.key));
}

/** Gaps already told, by reading, so a line drawn again doesn't tell one twice. */
const toldGaps = new Set<number>();

/** Tells of a reading the estimate before it missed by more than a small gap: a price feed or a holding gone wrong. */
function tellGap() {
  return (reading: Reading, gapUsd: number) => {
    if (toldGaps.has(reading.at)) return;
    if (toldGaps.size >= 10_000) toldGaps.clear();
    toldGaps.add(reading.at);
    const percent = ((gapUsd / Math.max(Math.abs(reading.usd), 1)) * 100).toFixed(1);
    const message = `reading at ${new Date(reading.at).toISOString()} was ${percent}% off its estimate`;
    console.warn(message);
  };
}

/** The first point with money in it on: a specialist formed a week before it was funded draws no week of $0. */
function funded<T extends { readonly usdValue: string }>(points: readonly T[]): T[] {
  const first = points.findIndex((point) => Number(point.usdValue) !== 0);
  return first === -1 ? [] : points.slice(first);
}

const STEP_MS: Readonly<Record<Step, number>> = { "15m": 15 * MINUTE_MS, "1h": 60 * MINUTE_MS };

/**
 * Today (from their midnight, every 15 minutes) or the week (every hour), and
 * now, from the readings in it and the one before. It starts at the first
 * reading when that is later, with a point there, so its first point is what
 * "today" on a specialist's tile counts from. Every reading in it is a point
 * too, so money that came and went between two steps still shows.
 */
async function estimatedLine(
  specialistId: string | null,
  range: "Today" | "1W",
  flows: readonly Flow[],
): Promise<ValuePoint[]> {
  const now = Date.now();
  const from = range === "Today" ? startOfDay((await theOwner()).timeZone, now) : now - 7 * DAY_MS;
  const step = range === "Today" ? "15m" : "1h";
  const [totals, userFills] = await Promise.all([
    totalReadings(from),
    specialistId ? allFills(db) : [],
  ]);
  const readings = readingsAs(splitReadings(totals, userFills), specialistId);
  const first = readings[0];
  if (!first) return [];
  const start = Math.max(from, first.at);
  const stepMs = STEP_MS[step];
  const steps = [start];
  for (let at = (Math.floor(start / stepMs) + 1) * stepMs; at < now; at += stepMs) steps.push(at);
  if (now > start) steps.push(now);
  const read = readings.flatMap((reading) =>
    reading.at > start && reading.at < now ? [reading.at] : [],
  );
  const times = [...new Set([...steps, ...read])].sort((a, b) => a - b);
  const paths = await readPaths(pathKeys(readings), step, now);
  // Told of on the total's line alone: a specialist's gap is a share of the same one.
  const onGap = specialistId ? undefined : tellGap();
  return funded(valueSeries({ readings, times, paths, flows, onGap }));
}

const RANGE_DAYS: Readonly<Record<"1M" | "3M" | "1Y", number>> = { "1M": 30, "3M": 90, "1Y": 365 };

/**
 * The readings over a month or longer: the first and last of each of their
 * days, so years of them stay a few hundred points while money put in during
 * a day is still weighed from that day, not from its end (a return weighs
 * what was put in by when); and the first with money in it, as a specialist
 * bought and sold within a day ends that day at zero and would otherwise
 * draw nothing. A specialist holds no plain cash.
 */
async function dailyReadings(
  specialistId: string | null,
  range: "1M" | "3M" | "1Y" | "All",
  flows: readonly Flow[],
): Promise<ValuePoint[]> {
  const inRange = and(
    readingsOf(specialistId),
    range === "All"
      ? undefined
      : gte(valueSnapshots.takenAt, new Date(Date.now() - RANGE_DAYS[range] * DAY_MS)),
  );
  const fields = {
    takenAt: valueSnapshots.takenAt,
    usdValue: valueSnapshots.usdValue,
    cashUsd: valueSnapshots.cashUsd,
    holdings: valueSnapshots.holdings,
  };
  // Their day by its name: Postgres won't match two copies, each with its own time zone parameter.
  const day = sql`day`;
  const { timeZone } = await theOwner();
  const ofEachDay = (order: typeof asc) =>
    db
      .selectDistinctOn([day], {
        ...fields,
        day: sql`(${valueSnapshots.takenAt} at time zone ${timeZone})::date`.as("day"),
      })
      .from(valueSnapshots)
      .where(inRange)
      .orderBy(day, order(valueSnapshots.takenAt));
  const [firstOfDays, lastOfDays, [firstFunded]] = await Promise.all([
    ofEachDay(asc),
    ofEachDay(desc),
    db
      .select(fields)
      .from(valueSnapshots)
      .where(and(inRange, ne(valueSnapshots.usdValue, "0")))
      .orderBy(asc(valueSnapshots.takenAt))
      .limit(1),
  ]);
  const kept = new Map(
    [...firstOfDays, ...lastOfDays, ...(firstFunded ? [firstFunded] : [])].map((row) => [
      row.takenAt.getTime(),
      row,
    ]),
  );
  const rows = [...kept.values()].sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
  return funded(
    rows.map((row) => {
      const at = row.takenAt.getTime();
      const cash = specialistId ? 0 : Number(row.cashUsd ?? 0);
      // Only the total's row keeps its holdings, so only its line knows what it held unpriced.
      const unpriced = unpricedOf(row.holdings ?? []);
      return {
        at,
        usdValue: row.usdValue,
        madeUsd: madeUsd(Number(row.usdValue), cash, flows, at, unpriced),
      };
    }),
  );
}

/** When the total or one specialist first held money, by its readings; null if it never did. */
async function startedAt(specialistId: string | null): Promise<Date | null> {
  const [first] = await db
    .select({ at: min(valueSnapshots.takenAt) })
    .from(valueSnapshots)
    .where(and(readingsOf(specialistId), ne(valueSnapshots.usdValue, "0")));
  return first?.at ?? null;
}

/**
 * The total (specialist null) or one specialist over `range`, from the first
 * reading with money in it. Each point says what had been made by then
 * (money/made.ts), so a chart's move leaves out money added or taken out.
 */
export async function valueHistory(
  specialistId: string | null,
  range: ValueRange,
): Promise<ValueHistoryWire> {
  const flows = await (specialistId
    ? specialistFlows([specialistId]).then((byId) => byId.get(specialistId) ?? [])
    : walletFlows());
  const [started, points] = await Promise.all([
    startedAt(specialistId),
    range === "Today" || range === "1W"
      ? estimatedLine(specialistId, range, flows)
      : dailyReadings(specialistId, range, flows),
  ]);
  return {
    startedAt: started?.toISOString() ?? null,
    points: points.map((point) => ({
      takenAt: new Date(point.at).toISOString(),
      usdValue: point.usdValue,
      madeUsd: point.madeUsd,
    })),
  };
}

/**
 * What each of these specialists had made at the start of the person's day,
 * by id, measured as Today's line is (its first point): so a tile's "today"
 * and the line under it agree. One with no reading yet is left out.
 */
export async function madeAtStartOfDay(
  flows: ReadonlyMap<string, readonly Flow[]>,
): Promise<Map<string, string>> {
  if (flows.size === 0) return new Map();
  const midnight = startOfDay((await theOwner()).timeZone);
  const [totals, userFills] = await Promise.all([totalReadings(midnight), allFills(db)]);
  const first = totals[0];
  if (!first) return new Map();
  const at = Math.max(midnight, first.takenAt.getTime());
  const split = splitReadings(totals, userFills);
  const bySpecialist = [...flows.keys()].map((id) => [id, readingsAs(split, id)] as const);
  const paths = await readPaths(
    bySpecialist.flatMap(([, readings]) => pathKeys(readings)),
    "15m",
    Date.now(),
  );
  return new Map(
    bySpecialist.flatMap(([id, readings]) => {
      const [point] = valueSeries({ readings, times: [at], paths, flows: flows.get(id) ?? [] });
      return point ? [[id, point.madeUsd]] : [];
    }),
  );
}
