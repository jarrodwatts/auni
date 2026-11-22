import type { MoneyToolName, VenueToolName } from "@auni/shared";
import { eq, inArray, min, sql } from "drizzle-orm";

import { db } from "../../db/client.ts";
import { actions, type ActionRow } from "../../db/schema.ts";
import { QUANTITY_DECIMALS } from "../../money/fill-key.ts";
import { priceLabel, usdLabel } from "../../money/format.ts";
import {
  orderOf,
  type Exit,
  type Happened,
  type Statement,
  type StatementEntry,
  type StatementFill,
} from "../../money/venue-statement.ts";
import { centsToUsd, formatUnits, parseUnits, signedUnits, usdToCents } from "../../money/usd.ts";
import { positionsOn } from "./account.ts";
import { info } from "./api.ts";
import { coinKey, tickerOf } from "./keys.ts";
import about from "./about.ts";
import { dexOf } from "./markets.ts";
import { standingOrders, stopsInPlace } from "./open-orders.ts";
import { stopOfTag, taggedAction } from "./orders.ts";

/** What Hyperliquid did by itself: a liquidation, auto-deleveraging, or a trade made in its own app. */
export const VENUE_FILL_TOOL = "hyperliquid_venue_fill" satisfies VenueToolName;

/** A fill as Hyperliquid lists it (userFillsByTime). */
interface VenueFill {
  readonly coin: string;
  readonly px: string;
  readonly sz: string;
  /** B buys, A sells. */
  readonly side: "B" | "A";
  readonly time: number;
  /** The position before it, signed: a short below zero. */
  readonly startPosition: string;
  /** How Hyperliquid's app labels it: "Close Long", "Auto-Deleveraging". */
  readonly dir: string;
  readonly closedPnl: string;
  /** The order it filled. */
  readonly oid: number;
  /** Unique to the trade, not to one side of it: two accounts trading with each other share it. */
  readonly tid: number;
  /** All its fees, Hyperliquid's and any builder's. */
  readonly fee: string;
  /** The tag its order carried, if any (see orderTag). */
  readonly cloid?: string;
  /** Present on a fill a liquidation made. */
  readonly liquidation?: { readonly liquidatedUser: string };
}

/** The most fills Hyperliquid lists at once; a full page goes on from its last fill's time. */
const PAGE = 2_000;

/**
 * How long a fill may take to show on the statement after its time: each read
 * is whole only up to this long ago, so the next goes on from there, and a
 * line read twice is recorded once.
 */
const OVERLAP_MS = 60_000;

/**
 * The statement of the owner's Hyperliquid account `address`: every perp
 * fill, on every dex, read with one call a page. A fill whose order carried
 * one of Auni's actions' tags is that action's. A spot
 * fill changes no position Auni keeps books of, so it is passed by.
 *
 * History before tags: orders Auni sent before it tagged them filled with no
 * tag, and were recorded from what Hyperliquid answered, so on the first
 * read an untagged fill is recorded only when it can't have been Auni's, one
 * a liquidation or auto-deleveraging made, from their first move on
 * Hyperliquid, as every tagged fill is; and that read ends where the next
 * begins, so no untagged fill from before it is ever read again.
 */
export function hyperliquidStatement(address: string): Statement {
  const account = address.toLowerCase();
  return {
    tool: VENUE_FILL_TOOL,
    async read(since) {
      const now = Date.now();
      const through = now - OVERLAP_MS;
      const from = since === null ? await firstMove() : since + 1;
      const to = since === null ? through : now;
      if (from === null || from > to) return { entries: [], through };
      const listed = (await fillsBetween(account, from, to)).filter(
        (fill) => !fill.coin.startsWith("@") && !fill.coin.includes("/"),
      );
      const tagged = await taggedActions(listed);
      const ours = (fill: VenueFill) =>
        fill.cloid !== undefined && tagged.has(taggedAction(fill.cloid));
      const read =
        since === null ? listed.filter((fill) => ours(fill) || causeOf(fill) !== "trade") : listed;
      return {
        entries: entriesOf(account, read, tagged, await stopsMissing(account, read, tagged)),
        through,
      };
    },
  };
}

/** When the owner first moved money on Hyperliquid through Auni: before any fill Auni's books hold. */
async function firstMove(): Promise<number | null> {
  const [first] = await db
    .select({ at: min(actions.createdAt) })
    .from(actions)
    .where(eq(actions.venue, about.id));
  return first?.at?.getTime() ?? null;
}

/** Every fill of the account from `from` through `to`, oldest first, once each. */
async function fillsBetween(account: string, from: number, to: number): Promise<VenueFill[]> {
  const byTrade = new Map<number, VenueFill>();
  for (let start = from; ;) {
    const page = await info<VenueFill[]>({
      type: "userFillsByTime",
      user: account,
      startTime: start,
      endTime: to,
    });
    for (const fill of page) byTrade.set(fill.tid, fill);
    const last = page.at(-1)?.time ?? to;
    if (page.length < PAGE || last >= to) break;
    // The page's last moment is listed again, so none of it is lost to the cut.
    start = last > start ? last : start + 1;
  }
  return [...byTrade.values()];
}

type Tagged = Pick<ActionRow, "id" | "tool" | "input">;

/** The tool whose orders open a position (see order.ts): only its fills can be an entry. */
const ORDER_TOOL = "hyperliquid_order" satisfies MoneyToolName;

/** The tool that changes a position's stops (see position.ts): all of its orders are stops. */
const SET_STOPS_TOOL = "hyperliquid_set_stops" satisfies MoneyToolName;

/**
 * Which of a tagged action's stops a fill was, by its order's tag: an order's stops follow its
 * entry's tag, a change of stops' start at the first; a close places none.
 */
function stopOf(fill: VenueFill, { tool, input }: Tagged): Exit | null {
  const kept = tool === ORDER_TOOL ? 1 : tool === SET_STOPS_TOOL ? 0 : null;
  return kept === null || !fill.cloid ? null : stopOfTag(fill.cloid, kept, input);
}

/** Which way a tagged action opens a position: an order's side; a close or a change of stops opens none. */
function opens({ tool, input }: Tagged): "long" | "short" | null {
  const { side } = input as { readonly side?: unknown };
  return tool === ORDER_TOOL && (side === "long" || side === "short") ? side : null;
}

/** The actions these fills' tags name, by what each tag keeps of the action's id. */
async function taggedActions(listed: readonly VenueFill[]): Promise<Map<string, Tagged>> {
  const tags = [
    ...new Set(listed.flatMap((fill) => (fill.cloid ? [taggedAction(fill.cloid)] : []))),
  ];
  if (tags.length === 0) return new Map();
  const tagOf = sql<string>`left(replace(${actions.id}::text, '-', ''), 30)`;
  const rows = await db
    .select({ id: actions.id, tool: actions.tool, input: actions.input, tag: tagOf })
    .from(actions)
    .where(inArray(tagOf, tags));
  return new Map(rows.map(({ tag, ...action }) => [tag, action]));
}

/** Whether a fill is of the order that opens its action's position: a limit order filling as it rests. */
function isEntry(fill: VenueFill, tagged: ReadonlyMap<string, Tagged>): boolean {
  const action = fill.cloid && tagged.get(taggedAction(fill.cloid));
  return !!action && orderOf(opens(action), fill.side === "B" ? "buy" : "sell") === "limit";
}

/**
 * For each order of Auni's among these fills that opened a position whose card showed stops,
 * by its id: what the owner is told when one of those stops is no longer on Hyperliquid, which
 * holds them from before the order fills (see stops.ts). Hyperliquid uses up a stop whose
 * price is reached while nothing is held, as a take-profit's can be before a resting order
 * fills. Hyperliquid is asked only when such an order filled, on the dexes where one did, and
 * nothing is said of a position that has closed since.
 */
async function stopsMissing(
  account: string,
  listed: readonly VenueFill[],
  tagged: ReadonlyMap<string, Tagged>,
): Promise<Map<number, string>> {
  const shown = (fill: VenueFill) => {
    const { stopLoss, takeProfit } = tagged.get(taggedAction(fill.cloid ?? ""))?.input as {
      readonly stopLoss?: number;
      readonly takeProfit?: number;
    };
    return { stopLoss, takeProfit };
  };
  const entries = listed.filter((fill) => {
    if (!isEntry(fill, tagged)) return false;
    const { stopLoss, takeProfit } = shown(fill);
    return stopLoss !== undefined || takeProfit !== undefined;
  });
  const dexes = [...new Set(entries.map((fill) => dexOf(fill.coin)))];
  const [open, held] = await Promise.all([
    Promise.all(dexes.map((dex) => standingOrders(account, dex))).then((each) => each.flat()),
    Promise.all(dexes.map((dex) => positionsOn(account, dex))).then((each) => each.flat()),
  ]);
  const missing = new Map<number, string>();
  for (const fill of entries) {
    const position = held.find(({ market }) => market === fill.coin);
    if (!position) continue;
    const inPlace = stopsInPlace(open, fill.coin, position.side);
    const { stopLoss, takeProfit } = shown(fill);
    const gone = [
      stopLoss !== undefined && inPlace.stopLoss.length === 0
        ? `stop-loss at ${priceLabel(stopLoss)}`
        : null,
      takeProfit !== undefined && inPlace.takeProfit.length === 0
        ? `take-profit at ${priceLabel(takeProfit)}`
        : null,
    ].filter((stop) => stop !== null);
    if (gone.length > 0) missing.set(fill.oid, stopsGone(tickerOf(fill.coin), gone));
  }
  return missing;
}

/**
 * What the owner is told when stops an order's card showed (each as "take-profit at $120.00")
 * are not on the position the order has now opened.
 */
function stopsGone(coin: string, stops: readonly string[]): string {
  const several = stops.length > 1;
  return `The ${stops.join(" and ")} this order's card showed ${several ? "are" : "is"} no longer on Hyperliquid, so your ${coin} position has ${several ? "neither" : "none"}. Set ${several ? "them" : "it"} again if you still want ${several ? "them" : "it"}.`;
}

/**
 * The fills as entries, in order, one for each moment something happened in
 * a market: an order of Auni's filling then, or what no order of Auni's did,
 * as one liquidation filling against several orders is one event. A stop
 * firing long after its move opened the position is an entry of its own.
 */
function entriesOf(
  account: string,
  listed: readonly VenueFill[],
  tagged: ReadonlyMap<string, Tagged>,
  stopsMissing: ReadonlyMap<number, string>,
): StatementEntry[] {
  const groups: { key: string; action: Tagged | null; fills: VenueFill[] }[] = [];
  for (const fill of listed) {
    const action = (fill.cloid && tagged.get(taggedAction(fill.cloid))) || null;
    const key = `${action?.id ?? fill.coin}:${fill.time}`;
    const last = groups.at(-1);
    if (last?.key === key) last.fills.push(fill);
    else groups.push({ key, action, fills: [fill] });
  }
  // Said once for an order, on the last of its fills read.
  const lastOf = new Map(groups.map(({ fills }, index) => [fills[0]!.oid, index]));
  return groups.map(({ action, fills }, index) => {
    const first = fills[0]!;
    const lines = fills.map((fill) => lineOf(account, fill));
    if (action) {
      const unfinished = lastOf.get(first.oid) === index ? stopsMissing.get(first.oid) : undefined;
      const cause = orderOf(opens(action), first.side === "B" ? "buy" : "sell");
      const exit = cause === "exit" ? stopOf(first, action) : null;
      return {
        actionId: action.id,
        fills: lines,
        happened: happenedOf(fills, cause),
        ...(exit ? { exit } : {}),
        ...(unfinished ? { unfinished } : {}),
      };
    }
    const happened = happenedOf(fills, causeOf(first));
    return { fills: lines, happened, summary: outsideSummary(happened) };
  });
}

/** One fill as a line. */
function lineOf(account: string, fill: VenueFill): StatementFill {
  return {
    ...coinKey(fill.coin),
    ref: `hyperliquid:${account}:${fill.tid}`,
    at: new Date(fill.time),
    side: fill.side === "B" ? "buy" : "sell",
    quantity: fill.sz,
    usdValue: notionalUsd(fill),
    before: signedUnits(fill.startPosition, QUANTITY_DECIMALS),
    pnlUsd: fill.closedPnl,
  };
}

/** A fill's size times its price, to the cent below. */
function notionalUsd(fill: Pick<VenueFill, "sz" | "px">): string {
  return centsToUsd((parseUnits(fill.sz, 9) * parseUnits(fill.px, 9) * 100n) / 10n ** 18n);
}

/** What made a fill no order of Auni's made: Hyperliquid itself, or a trade someone placed elsewhere. */
function causeOf(fill: VenueFill): Exclude<Happened["cause"], "limit" | "exit"> {
  // An auto-deleveraged fill may name the liquidation it answered too.
  if (fill.dir === "Auto-Deleveraging") return "auto-deleveraging";
  return fill.liquidation ? "liquidation" : "trade";
}

/**
 * What fills of one event did to the position, in Hyperliquid's own numbers:
 * the position before and after, the price, and what it locked in. Nothing
 * the venue wrote is kept but its numbers and the market's name.
 */
function happenedOf(fills: readonly VenueFill[], cause: Happened["cause"]): Happened {
  const first = fills[0]!;
  const units = fills.reduce((sum, fill) => sum + parseUnits(fill.sz, QUANTITY_DECIMALS), 0n);
  const before = signedUnits(first.startPosition, QUANTITY_DECIMALS);
  const after = before + (first.side === "B" ? units : -units);
  const cents = fills.reduce((sum, fill) => sum + usdToCents(notionalUsd(fill)), 0n);
  const size = formatUnits(units, QUANTITY_DECIMALS);
  const price = fills.length === 1 ? Number(first.px) : Number(centsToUsd(cents)) / Number(size);
  return {
    cause,
    market: first.coin,
    side: first.side === "B" ? "buy" : "sell",
    size,
    priceUsd: String(Number(price.toPrecision(6))),
    before: formatUnits(before, QUANTITY_DECIMALS),
    after: formatUnits(after, QUANTITY_DECIMALS),
    closedPnlUsd: formatUnits(
      fills.reduce((sum, fill) => sum + signedUnits(fill.closedPnl, 6), 0n),
      6,
    ),
    venueFeeUsd: formatUnits(
      fills.reduce((sum, fill) => sum + signedUnits(fill.fee, 6), 0n),
      6,
    ),
  };
}

/**
 * What no order of Auni's did, as its done action says it, reading the same
 * to the owner and on a public page: "Hyperliquid liquidated the STRK long:
 * 193.1 sold at $0.07855, losing $5.26".
 */
function outsideSummary(happened: Happened): string {
  const { cause, market, side, size } = happened;
  const verb = side === "buy" ? "bought" : "sold";
  const pnl = Number(happened.closedPnlUsd);
  const result = pnl === 0 ? "" : `, ${pnl < 0 ? "losing" : "making"} ${usdLabel(Math.abs(pnl))}`;
  const price = priceLabel(Number(happened.priceUsd));
  if (cause === "trade")
    return `A trade made outside Auni ${verb} ${size} ${market} at ${price}${result}`;
  const position = `${market} ${happened.before.startsWith("-") ? "short" : "long"}`;
  return `Hyperliquid ${cause === "liquidation" ? "liquidated" : "auto-deleveraged"} ${Number(happened.after) === 0 ? "the" : "part of the"} ${position}: ${size} ${verb} at ${price}${result}`;
}
