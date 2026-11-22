import { priceLabel } from "../../money/format.ts";
import { MayHaveSent, type Signer } from "../../money/recipe.ts";
import { cancelOrders, cancelTagged, readPosition } from "./account.ts";
import type { Market } from "./markets.ts";
import { standingOrders, stopsInPlace, type Standing } from "./open-orders.ts";
import { orderAction, placeStops, stopLegs, type Stops } from "./orders.ts";
import { refusal, saidThen } from "./problems.ts";

// A stop-loss or a take-profit belongs to a position, never to the order that opens it. A
// position has at most one of each, and each is an order Hyperliquid holds for the whole
// position: it is accepted before the position exists, closes whatever is held when the price
// reaches it, and needs nothing of Auni, which may be switched off. So a move that shows stops
// sends them ahead of anything that could fill, and a move that sets one takes off the one it
// replaces. What Auni watches for is only what it tells the owner.
//
//   an order with stops       stops on (whole position)  >  entry  >  the stops it replaces off
//   the entry is refused      the stops just sent come back off, and nothing has changed
//   a change of stops         new on  >  old off, so the position is never bare
//   an order is cancelled     with nothing held and nothing else waiting, its stops come off too
//
// One thing Hyperliquid does that no order of sending prevents: a stop whose price is reached
// while nothing is held is used up, with nothing bought or sold. For a stop-loss that takes the
// price passing the entry without filling it. For a take-profit it takes only the price running
// to the target before a resting order fills, so the statement says so when that order then
// fills (see stopsMissing in statement.ts).

/** What stands for one market's position: its stops, and whether anything is there for them to protect. */
export interface Protection {
  readonly stopLoss: readonly Standing[];
  readonly takeProfit: readonly Standing[];
  /**
   * Nothing is held and no order waits to open anything, so every stop here is left over from
   * an order that ended elsewhere, and would act on whatever position is opened next.
   */
  readonly leftOver: boolean;
}

/** The protection on a market, from every order standing on its dex and whether a position is open. */
export function protectionOf(
  orders: readonly Standing[],
  market: string,
  held: boolean,
): Protection {
  const opening = orders.some(
    (order) => order.market === market && order.kind === "limit" && !order.reduceOnly,
  );
  return { ...stopsInPlace(orders, market), leftOver: !held && !opening };
}

/**
 * The owner's position on a market and what protects it, read now. With no wallet there is
 * neither.
 */
export async function protectionNow(owner: string | null, market: Market) {
  const [position, orders] = owner
    ? await Promise.all([readPosition(owner, market), standingOrders(owner, market.dex)])
    : [null, []];
  return { position, orders, protection: protectionOf(orders, market.name, position !== null) };
}

/**
 * The stops a move that sets `next` takes off once its own are on: every one of each kind it
 * sets, since a position has one of each, and every stop left over from an order that ended.
 */
export function replacedBy(now: Protection, next: Stops): Standing[] {
  return [
    ...(next.stopLoss !== undefined || now.leftOver ? now.stopLoss : []),
    ...(next.takeProfit !== undefined || now.leftOver ? now.takeProfit : []),
  ];
}

/**
 * Why stops sent for a position on one side (`isLong`) would leave an order `waiting` on the
 * market with none, or null when they wouldn't. A position has one stop-loss and one
 * take-profit, each one order Hyperliquid holds for the whole position, so:
 *
 *   an order waits to open the other way    these stops would take off the ones it relies on,
 *                                           and close only this side: it could fill bare
 *   a stop-loss sits between the price now  it fires before that order can fill, and a stop
 *   and the limit of an order on this side  that fires is used up: the order then fills bare
 */
export function stopsLeaveBare(
  market: Market,
  isLong: boolean,
  stops: Stops,
  waiting: readonly Standing[],
): string | null {
  if (stops.stopLoss === undefined && stops.takeProfit === undefined) return null;
  const side = (buys: boolean) => (buys ? "long" : "short");
  const opening = waiting.filter(
    (order) => order.market === market.name && order.kind === "limit" && !order.reduceOnly,
  );
  const against = opening.find((order) => order.isBuy !== isLong);
  if (against)
    return (
      `A ${side(against.isBuy)} order waits on ${market.name} at ${priceLabel(Number(against.price))}, ` +
      `and a position's stops close one side only: stops for this ${side(isLong)} would take off ` +
      "the ones that order relies on. Cancel that order first, or send this without a stop-loss " +
      "or take-profit."
    );
  const { stopLoss } = stops;
  if (stopLoss === undefined) return null;
  const past = opening.find(
    (order) =>
      order.isBuy === isLong &&
      (isLong ? Number(order.price) < stopLoss : Number(order.price) > stopLoss),
  );
  if (!past) return null;
  const beyond = isLong ? "below" : "above";
  const limit = priceLabel(Number(past.price));
  return (
    `A ${side(isLong)} order still waits on ${market.name} at ${limit}, ${beyond} this stop-loss ` +
    `at ${priceLabel(stopLoss)}: the stop would fire before that order could fill, and a stop ` +
    `that fires is used up, so the order would then fill with no stop. Set the stop-loss ` +
    `${beyond} ${limit}, or cancel that order first.`
  );
}

/** A stop as the owner reads it: "stop-loss at $85,000". */
export function stopWords({ kind, price }: Pick<Standing, "kind" | "price">): string {
  return `${kind} at ${priceLabel(Number(price))}`;
}

/** Said when a stop a move had just placed could not be taken back. */
const MAY_REMAIN =
  "A stop sent with it may still be on Hyperliquid, where it can only close a position, never open one.";

/**
 * Puts `stops` on the market's whole position, tagged as the action's from `first` among its
 * orders, and returns their tags. All or none: if Hyperliquid refuses one, or never answers,
 * those it took (or may have taken) are taken back, and what it said is thrown, followed by
 * `unchanged`, which says what stands now that none of them is in place.
 */
export async function placeWholePositionStops(
  wallets: Signer,
  market: Market,
  isLong: boolean,
  stops: Stops,
  tagged: { readonly actionId: string; readonly first: number },
  unchanged: string,
): Promise<readonly string[]> {
  const request = orderAction(
    stopLegs(market, isLong, stops),
    "positionTpsl",
    tagged.actionId,
    tagged.first,
  );
  const tags = request.orders.map((order) => order.c!);
  if (tags.length === 0) return [];
  const answers = await placeStops(wallets, request).catch((error: unknown) => {
    // No answer: any of them may be in place. Anything else is Hyperliquid turning the whole
    // request away, so none is, and the move fails in its words.
    if (error instanceof MayHaveSent) return null;
    throw saidThen(error instanceof Error ? error : new Error(String(error)), unchanged);
  });
  const refused = answers?.find((answer) => answer !== null);
  if (answers && refused === undefined) return tags;
  const taken = answers ? tags.filter((_, index) => answers[index] === null) : tags;
  const after = (await takeBackStops(wallets, market, taken)) ?? unchanged;
  throw refused
    ? refusal(refused, after)
    : new Error(`Hyperliquid didn't answer when the stops were sent. ${after}`);
}

/**
 * Takes back stops a move has just placed, by their tags. Null once none of them stands; else
 * the sentence that says one may. Hyperliquid's word is checked against what it lists: when it
 * refuses to cancel any of them, or doesn't answer, the open orders are read, and any of them
 * still there is cancelled by its order id.
 */
export async function takeBackStops(
  wallets: Signer,
  market: Market,
  tags: readonly string[],
): Promise<string | null> {
  const ours = ({ tag }: Standing) => tag !== null && tags.includes(tag);
  const refused = await cancelTagged(wallets, market, tags).catch((error: unknown) => {
    console.error(`${market.name}: stops just placed weren't taken back`, error);
    return null;
  });
  if (refused?.length === 0) return null;
  const standing = await stillStanding(wallets, market, ours);
  if (standing?.length === 0) return null;
  const left = standing && (await cancelStanding(wallets, market, standing));
  return left?.length === 0 ? null : MAY_REMAIN;
}

/**
 * Takes off stops a move replaces or leaves with nothing to protect. Null once they are gone;
 * else a sentence that says which may still stand. When Hyperliquid refuses to cancel any of
 * them, or doesn't answer, the open orders are read for what really stands: one it refused as
 * already filled or cancelled is gone.
 */
export async function removeReplaced(
  wallets: Signer,
  market: Market,
  replaced: readonly Standing[],
): Promise<string | null> {
  if (replaced.length === 0) return null;
  const left = await cancelStanding(wallets, market, replaced);
  if (left.length === 0) return null;
  const said = left.map(stopWords).join(" and ");
  return `The earlier ${said} could not be taken off, and may still be in place.`;
}

/**
 * Cancels `orders` by their ids, and returns those still standing after: none when Hyperliquid
 * took every cancel; else what the open orders list of them, read now, or all of them when
 * those can't be read.
 */
async function cancelStanding(
  wallets: Signer,
  market: Market,
  orders: readonly Standing[],
): Promise<readonly Standing[]> {
  const refused = await cancelOrders(
    wallets,
    market,
    orders.map(({ oid }) => oid),
  ).catch((error: unknown) => {
    console.error(`${market.name}: stops weren't cancelled`, error);
    return null;
  });
  if (refused?.length === 0) return [];
  const oids = new Set(orders.map(({ oid }) => oid));
  return (await stillStanding(wallets, market, ({ oid }) => oids.has(oid))) ?? orders;
}

/** The orders on the market that `which` picks, read now; null when they can't be read. */
async function stillStanding(
  wallets: Signer,
  market: Market,
  which: (order: Standing) => boolean,
): Promise<Standing[] | null> {
  return standingOrders(wallets.evmAddress, market.dex).then(
    (orders) => orders.filter((order) => order.market === market.name && which(order)),
    (error: unknown) => {
      console.error(`${market.name}: open orders couldn't be read`, error);
      return null;
    },
  );
}
