import type { PickDetailWire } from "@auni/shared";

import {
  change,
  DETAIL_TTL_MS,
  quarterFact,
  since,
  todayFact,
  topFacts,
  type Fact,
  type Level,
} from "../../money/detail-facts.ts";
import { usdLabel } from "../../money/format.ts";
import type { PickedAction, Traded } from "../../money/recipe.ts";
import { cached } from "../../money/swaps/shared.ts";
import { evmAddress } from "../../money/wallets.ts";
import { findMarket, perpMark } from "./markets.ts";
import { hyperliquidPrices } from "./prices.ts";
import { protectionNow } from "./stops.ts";

// A perp: Hyperliquid's daily candles and its live mark and funding.

const perpCandles = cached(DETAIL_TTL_MS, async (market) =>
  (await hyperliquidPrices.history(market, "1d", since())).map((point) => ({
    at: new Date(point.at).toISOString(),
    value: point.price,
  })),
);

/**
 * What holding it costs (or earns) a day, from Hyperliquid's hourly funding.
 * The label says which way it goes, so the value stays a short figure.
 */
function holdingCost(funding: number, notionalUsd: number, side: "long" | "short"): Fact {
  // Longs pay positive funding and shorts receive it.
  const daily = funding * 24 * notionalUsd * (side === "long" ? 1 : -1);
  if (Math.abs(daily) < 0.01) return { label: "Holding cost", value: "Under a cent a day" };
  return daily > 0
    ? { label: "Holding costs", value: `${usdLabel(daily)} a day` }
    : { label: "Holding pays you", value: `${usdLabel(-daily)} a day` };
}

/**
 * Where a position takes profit, stops out and is wiped out. An order not yet
 * placed has them as it asked, its wipe-out estimated from today's price;
 * once placed, or for a close, they're the live position's own, since adding
 * to it or moving its stops changes them. The stops of an order still waiting
 * are in place before its position is, so they show with nothing held, unless
 * no order waits either and they are only left over. A read that fails shows none.
 */
async function perpLevels(
  { market, opens }: Extract<Traded, { kind: "perp" }>,
  action: PickedAction,
  now: number,
): Promise<Level[]> {
  if (opens && action.status !== "done") {
    const { stopLoss, takeProfit } = action.input as { stopLoss?: number; takeProfit?: number };
    const move = opens.liquidationMove;
    return [
      takeProfit === undefined ? null : { kind: "take_profit" as const, price: takeProfit },
      stopLoss === undefined ? null : { kind: "stop" as const, price: stopLoss },
      move === undefined
        ? null
        : {
            kind: "liquidation" as const,
            price: now * (opens.side === "long" ? 1 - move : 1 + move),
          },
    ].filter((level) => level !== null);
  }
  try {
    const [resolved, owner] = await Promise.all([findMarket(market), evmAddress()]);
    const { position, protection } = await protectionNow(owner, resolved);
    if (protection.leftOver) return [];
    const { takeProfit, stopLoss } = protection;
    return [
      takeProfit[0] ? { kind: "take_profit" as const, price: Number(takeProfit[0].price) } : null,
      stopLoss[0] ? { kind: "stop" as const, price: Number(stopLoss[0].price) } : null,
      position?.liquidationPx == null
        ? null
        : { kind: "liquidation" as const, price: position.liquidationPx },
    ].filter((level) => level !== null);
  } catch (error) {
    console.error(`couldn't read the ${market} position's levels`, error);
    return [];
  }
}

export async function perpDetail(
  subject: Extract<Traded, { kind: "perp" }>,
  action: PickedAction,
): Promise<PickDetailWire | null> {
  const { market, opens } = subject;
  const [history, live] = await Promise.all([perpCandles(market), perpMark(market)]);
  const now = live?.mark ?? history.at(-1)?.value;
  if (now === undefined || !Number.isFinite(now) || history.length < 2) return null;
  const today = live ? change(live.previous, live.mark) : null;
  // Opening one, the facts say what's particular to that position; closing one, how it's moved.
  const facts = topFacts([
    opens ? { label: "Position", value: `${opens.leverage}x ${opens.side}` } : null,
    opens && live ? holdingCost(live.funding, opens.sizeUsd, opens.side) : null,
    todayFact(today),
    quarterFact(history, now),
  ]);
  return {
    kind: "price",
    label: market.includes(":") ? "Perp on Hyperliquid, tracks the stock" : "Perp on Hyperliquid",
    now,
    today,
    points: [...history, { at: new Date().toISOString(), value: now }],
    facts,
    levels: await perpLevels(subject, action, now),
  };
}
