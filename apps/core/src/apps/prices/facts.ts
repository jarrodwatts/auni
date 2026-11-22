import { roughDollars } from "../../money/summaries.ts";
import { stockLogo } from "../../money/swaps/stock-index.ts";
import { startFrom, type AppFact, type OwnerSeen } from "../contract.ts";
import { marketDays, type MarketDay } from "./hyperliquid.ts";

// What prices are doing today: the biggest moves among Hyperliquid's most traded markets, and the
// day of anything the owner holds that it lists. From its public prices, with no key.

/** Hyperliquid's own markets, and the dex its stocks, indices and commodities trade on. */
const DEXES = ["", "xyz"];
const MOST_TRADED = 20;
const MOVERS = 3;

export async function priceFacts(seen: OwnerSeen, signal: AbortSignal): Promise<AppFact[]> {
  const days = (await Promise.all(DEXES.map((dex) => marketDays(dex, signal)))).flat();
  const movers = days
    .toSorted((a, b) => b.traded - a.traded)
    .slice(0, MOST_TRADED)
    .toSorted((a, b) => Math.abs(change(b)) - Math.abs(change(a)))
    .slice(0, MOVERS);
  const held = seen.holdings.flatMap(
    ({ symbol }) => days.find((day) => tickerOf(day.market) === listedAs(symbol)) ?? [],
  );
  return Promise.all([
    ...movers.map((day) => moverFact(day, held.includes(day))),
    ...held.filter((day) => !movers.includes(day)).map(heldFact),
  ]);
}

async function moverFact(day: MarketDay, held: boolean): Promise<AppFact> {
  const ticker = tickerOf(day.market);
  const name = held ? `${ticker}, which the owner holds,` : ticker;
  const whose = held ? `Your ${ticker}` : ticker;
  return {
    ...(await cited(day)),
    text: `${name} is ${moved(day)} in the last day on Hyperliquid, at ${price(day.price)}, with ${roughDollars(day.traded)} traded.`,
    starts: startFrom(
      `${held ? `${ticker}, which I hold,` : ticker} is ${moved(day)} in the last day on Hyperliquid. What's behind the move, and is there a take in it for me?`,
      [
        { statement: `${whose} is ${moved(day)} today.`, action: "Why?" },
        { statement: `${whose} is ${moved(day)}.`, action: "Why?" },
        { statement: `${ticker} is ${moved(day)}.`, action: "Why?" },
      ],
    ),
  };
}

async function heldFact(day: MarketDay): Promise<AppFact> {
  const ticker = tickerOf(day.market);
  return {
    ...(await cited(day)),
    text: `${ticker}, which the owner holds, is ${moved(day)} in the last day on Hyperliquid, at ${price(day.price)}.`,
    starts: startFrom(
      `${ticker}, which I hold, is ${moved(day)} in the last day. What's going on with it, and should I do anything?`,
      [
        { statement: `Your ${ticker} is ${moved(day)} today.`, action: "What next?" },
        { statement: `Your ${ticker} is ${moved(day)}.`, action: "What next?" },
        { statement: `${ticker} is ${moved(day)}.`, action: "What next?" },
      ],
    ),
  };
}

async function cited(day: MarketDay): Promise<Pick<AppFact, "label" | "link" | "image">> {
  return {
    label: `${tickerOf(day.market)} on Hyperliquid`,
    link: `https://app.hyperliquid.xyz/trade/${day.market}`,
    image: await logoOf(day.market),
  };
}

/**
 * What a market trades, as its picture: a stock's own mark for one on a stock dex (xyz:NVDA is
 * Nvidia), Hyperliquid's coin art for a coin.
 */
async function logoOf(market: string): Promise<string | null> {
  const ticker = tickerOf(market);
  if (ticker !== market) return stockLogo(ticker).catch(() => null);
  return `https://app.hyperliquid.xyz/coins/${market}.svg`;
}

/** Percent moved since a day ago. */
function change(day: MarketDay): number {
  return (day.price / day.dayAgo - 1) * 100;
}

/** "up 4.2%", "down 0.3%", "flat". */
function moved(day: MarketDay): string {
  const percent = change(day);
  if (Math.abs(percent) < 0.05) return "flat";
  return `${percent > 0 ? "up" : "down"} ${Math.abs(percent).toFixed(1)}%`;
}

function price(usd: number): string {
  return usd >= 1
    ? `$${usd.toLocaleString("en-US", { maximumFractionDigits: usd >= 1_000 ? 0 : 2 })}`
    : `$${usd.toPrecision(4)}`;
}

/** "NVDA" for "xyz:NVDA". */
function tickerOf(market: string): string {
  return market.slice(market.indexOf(":") + 1);
}

/** The ticker a held symbol trades as here: an xStock ("NVDAx") is its stock's. */
function listedAs(symbol: string): string {
  return /^[A-Z]+x$/u.test(symbol) ? symbol.slice(0, -1) : symbol;
}
