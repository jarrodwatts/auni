import { asc, eq, type SQL } from "drizzle-orm";

import { db } from "../db/client.ts";
import { actions, fills } from "../db/schema.ts";
import { isMargined } from "../apps/registry.ts";
import { fillIdentity } from "./fill-key.ts";

/*
 * Money moved into and out of holdings. A buy puts money in and a sell takes
 * it out, so neither counts as gain or loss; only what the holdings did in
 * between does (see made.ts).
 */

/** Money moved at a time: positive for a buy, negative for a sell, in dollars. */
export interface Flow {
  readonly at: number;
  readonly usd: number;
  /** The holding it moved into or out of, by fillIdentity (see madeUsd). */
  readonly key?: string;
}

/** One fill as returns count it. A perp carries its leverage when the order said it. */
interface FillFlow {
  readonly at: number;
  readonly side: "buy" | "sell";
  readonly usd: number;
  readonly quantity: number;
  readonly instrument: string;
  readonly perp: boolean;
  readonly leverage: number | null;
}

/**
 * Money in and out of a specialist. A spot buy puts its cost in and a sale
 * takes its proceeds out. A perp puts in only its margin (notional over
 * leverage), and reducing it takes out that part's margin plus what it made
 * or lost, the way the venue settles it, so leverage never reads as a loss.
 */
export function flowsOf(fills: readonly FillFlow[]): Flow[] {
  const positions = new Map<string, { size: number; avgPx: number; leverage: number }>();
  return fills.map((fill) => {
    if (!fill.perp || fill.quantity <= 0)
      return { at: fill.at, usd: fill.side === "buy" ? fill.usd : -fill.usd };
    const price = fill.usd / fill.quantity;
    const signed = fill.side === "buy" ? fill.quantity : -fill.quantity;
    const position = positions.get(fill.instrument) ?? {
      size: 0,
      avgPx: price,
      leverage: fill.leverage ?? 1,
    };
    const leverage = fill.leverage ?? position.leverage;
    positions.set(fill.instrument, position);
    // The venue re-margins the whole position when an order changes its leverage.
    const margin = () => (Math.abs(position.size) * position.avgPx) / position.leverage;
    if (position.size === 0 || Math.sign(position.size) === Math.sign(signed)) {
      const before = margin();
      const size = position.size + signed;
      position.avgPx =
        (Math.abs(position.size) * position.avgPx + fill.quantity * price) / Math.abs(size);
      position.size = size;
      position.leverage = leverage;
      return { at: fill.at, usd: margin() - before };
    }
    let usd = 0;
    if (leverage !== position.leverage) {
      const before = margin();
      position.leverage = leverage;
      usd += margin() - before;
    }
    const closing = Math.min(fill.quantity, Math.abs(position.size));
    const made = closing * (price - position.avgPx) * Math.sign(position.size);
    usd -= (closing * position.avgPx) / position.leverage + made;
    const flipped = fill.quantity - closing;
    if (flipped > 0) {
      position.size = Math.sign(signed) * flipped;
      position.avgPx = price;
      position.leverage = leverage;
      usd += (flipped * price) / leverage;
    } else {
      position.size += signed;
      if (Math.abs(position.size) < 1e-12) position.size = 0;
    }
    return { at: fill.at, usd };
  });
}

/** The fills `where` picks, oldest first, each with the leverage its order asked for. */
export async function fillsWithLeverage(where?: SQL) {
  const rows = await db
    .select({
      specialistId: fills.specialistId,
      side: fills.side,
      usdValue: fills.usdValue,
      quantity: fills.quantity,
      input: actions.input,
      chain: fills.chain,
      instrument: fills.instrument,
      createdAt: fills.createdAt,
    })
    .from(fills)
    .innerJoin(actions, eq(actions.id, fills.actionId))
    .where(where)
    .orderBy(asc(fills.createdAt), asc(fills.id));
  return rows.map(({ input, ...row }) => ({
    ...row,
    leverage: typeof input.leverage === "number" && input.leverage >= 1 ? input.leverage : null,
  }));
}

type LeveredFill = Awaited<ReturnType<typeof fillsWithLeverage>>[number];

/** Fills as money in and out of the holdings they trade, perps on their margin (see flowsOf). */
export function flowsFrom(theirFills: readonly LeveredFill[]): Flow[] {
  const flows = flowsOf(
    theirFills.map((fill) => ({
      at: fill.createdAt.getTime(),
      side: fill.side,
      usd: Number(fill.usdValue),
      quantity: Number(fill.quantity),
      instrument: fill.instrument,
      // A fill of a leveraged account is a perp, valued by its app at margin plus what it made.
      perp: isMargined(fill),
      leverage: fill.leverage,
    })),
  );
  return flows.map((flow, index) => ({ ...flow, key: fillIdentity(theirFills[index]!) }));
}
