import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import { priceLabel } from "../../money/format.ts";
import { counted, defineTool, result } from "../../agent/tool.ts";
import { db } from "../../db/client.ts";
import { actions } from "../../db/schema.ts";
import { cached } from "../../money/swaps/shared.ts";
import { info } from "./api.ts";

export const MINIMUM_ORDER_USD = 10;

export interface Market {
  readonly name: string;
  readonly dex: string;
  readonly assetId: number;
  readonly szDecimals: number;
  readonly maxLeverage: number;
  readonly markPx: number;
  readonly dayVolumeUsd: number;
  readonly fundingRate: number;
  /** The spot token its dex margins in; 0 is USDC. */
  readonly collateralToken: number;
}

interface Universe {
  readonly universe: readonly {
    readonly name: string;
    readonly szDecimals: number;
    readonly maxLeverage: number;
    readonly isDelisted?: boolean;
  }[];
  readonly collateralToken?: number;
}

interface AssetContext {
  readonly markPx: string;
  readonly dayNtlVlm: string;
  readonly funding: string;
}

/**
 * Every perps dex, the main one ("") first, in the order asset ids count
 * them. A new dex is rare, so the list is read once every ten minutes rather
 * than on every account read, where it cost as much as the rest together.
 */
const perpDexs = cached(10 * 60_000, async () => {
  const dexes = await info<readonly ({ readonly name: string } | null)[]>({ type: "perpDexs" });
  return dexes.map((dex, index) => ({ index, name: dex?.name ?? "" }));
});

export function listDexes(): Promise<readonly { readonly index: number; readonly name: string }[]> {
  return perpDexs("");
}

/** The perps dex a market trades on: "xyz" for "xyz:NVDA", the main dex ("") for "BTC". */
export function dexOf(market: string): string {
  return market.includes(":") ? market.split(":")[0]! : "";
}

/**
 * Every market a Hyperliquid move of Auni's started on, as its card
 * resolved it: an order filled at once or resting, and a close.
 */
export async function tradedMarkets(): Promise<string[]> {
  const market = sql<string>`${actions.details}->>'market'`;
  const rows = await db
    .selectDistinct({ market })
    .from(actions)
    .where(and(eq(actions.venue, "hyperliquid"), isNotNull(actions.startedAt), isNotNull(market)));
  return rows.map((row) => row.market);
}

async function loadMarkets(dex: {
  readonly index: number;
  readonly name: string;
}): Promise<Market[]> {
  const [meta, contexts] = await info<[Universe, readonly AssetContext[]]>({
    type: "metaAndAssetCtxs",
    // The main dex is selected by omitting `dex`; an unknown name is an HTTP 500.
    ...(dex.name === "" ? {} : { dex: dex.name }),
  });
  const markets: Market[] = [];
  meta.universe.forEach((entry, slot) => {
    const context = contexts[slot];
    if (entry.isDelisted || !context) return;
    markets.push({
      name: entry.name,
      dex: dex.name,
      // Delisted markets keep their slot, so asset ids count from the original position.
      assetId: dex.index === 0 ? slot : 100_000 + dex.index * 10_000 + slot,
      szDecimals: entry.szDecimals,
      maxLeverage: entry.maxLeverage,
      markPx: Number(context.markPx),
      dayVolumeUsd: Number(context.dayNtlVlm),
      fundingRate: Number(context.funding),
      collateralToken: meta.collateralToken ?? 0,
    });
  });
  return markets;
}

/** Every perp's mark, previous-day price and hourly funding on one dex ("" is the main one). */
const dexMarks = cached(60_000, async (dex) => {
  const [meta, contexts] = await info<
    [{ universe: { name: string }[] }, { markPx: string; prevDayPx: string; funding: string }[]]
  >(
    { type: "metaAndAssetCtxs", ...(dex ? { dex } : {}) },
    // Screens wait on this, so it gives up sooner than a trade's reads.
    8_000,
  );
  return new Map(
    meta.universe.map((asset, index) => [
      asset.name,
      {
        mark: Number(contexts[index]?.markPx),
        previous: Number(contexts[index]?.prevDayPx),
        funding: Number(contexts[index]?.funding),
      },
    ]),
  );
});

/** A perp's mark, previous-day price and hourly funding, for display; cached a minute. */
export async function perpMark(market: string) {
  return (await dexMarks(dexOf(market))).get(market);
}

async function loadAllMarkets(): Promise<Market[]> {
  const dexes = await listDexes();
  return (await Promise.all(dexes.map((dex) => loadMarkets(dex)))).flat();
}

export async function findMarket(query: string): Promise<Market> {
  const wanted = query.trim().toLowerCase();
  const dexes = await listDexes();
  const prefix = wanted.includes(":") ? wanted.split(":")[0] : undefined;
  const main = dexes.find((dex) => dex.name === "");
  if (prefix === undefined && main) {
    const hit = (await loadMarkets(main)).find((market) => market.name.toLowerCase() === wanted);
    if (hit) return hit;
  }
  const candidates = dexes.filter(
    (dex) => dex.name !== "" && (prefix === undefined || dex.name === prefix),
  );
  const hits = (await Promise.all(candidates.map((dex) => loadMarkets(dex))))
    .flat()
    .filter((market) => {
      const name = market.name.toLowerCase();
      return name === wanted || name.split(":")[1] === wanted;
    });
  const [only] = hits;
  if (hits.length === 1 && only) return only;
  if (hits.length > 1) {
    throw new Error(
      `${query} is listed on more than one Hyperliquid dex (${hits.map((hit) => hit.name).join(", ")}). Name one of them exactly.`,
    );
  }
  throw new Error(
    `Hyperliquid lists no open market named ${query}. Search with hyperliquid_markets.`,
  );
}

// At most 5 significant figures (whole numbers always pass) and 6 - szDecimals decimals.
export function formatPrice(
  price: number,
  szDecimals: number,
  direction: "up" | "down" | "nearest",
): string {
  if (!(price > 0)) throw new Error("Hyperliquid prices must be positive");
  const magnitude = Math.floor(Math.log10(price));
  const decimals = Math.max(0, Math.min(6 - szDecimals, 4 - magnitude));
  const scale = 10 ** decimals;
  // Settle float noise (336.62 * 100 = 33661.999...) before rounding directionally.
  const scaled = Number((price * scale).toFixed(6));
  const rounded =
    direction === "up"
      ? Math.ceil(scaled)
      : direction === "down"
        ? Math.floor(scaled)
        : Math.round(scaled);
  return trimDecimal((Math.max(rounded, 1) / scale).toFixed(decimals));
}

export function formatSize(
  size: number,
  szDecimals: number,
  direction: "down" | "up" = "down",
): string {
  const scale = 10 ** szDecimals;
  const scaled = Number((size * scale).toFixed(6));
  const lots = direction === "up" ? Math.ceil(scaled) : Math.floor(scaled);
  return trimDecimal((lots / scale).toFixed(szDecimals));
}

function trimDecimal(value: string): string {
  return value.includes(".") ? value.replace(/0+$/u, "").replace(/\.$/u, "") : value;
}

const marketsInput = {
  query: z
    .string()
    .min(1)
    .describe('Ticker or part of one, e.g. "BTC", "NVDA", "xyz:GOLD", "oil". Matches every dex.'),
};

export const hyperliquidMarkets = defineTool({
  name: "hyperliquid_markets",
  description:
    "Search Hyperliquid perpetual markets by ticker across the main dex and HIP-3 dexes (xyz lists stocks like xyz:NVDA and commodities like xyz:GOLD). Returns each match's exact market name to trade, mark price, max leverage, 24h volume, and hourly funding.",
  inputSchema: marketsInput,
  async handler(input) {
    const wanted = input.query.trim().toLowerCase();
    const matches = (await loadAllMarkets())
      .filter((market) => market.name.toLowerCase().includes(wanted))
      .sort((left, right) => right.dayVolumeUsd - left.dayVolumeUsd)
      .slice(0, 25);
    const markets = matches.map((market) => ({
      market: market.name,
      markPrice: market.markPx,
      maxLeverage: market.maxLeverage,
      dayVolumeUsd: Math.round(market.dayVolumeUsd),
      hourlyFundingRate: market.fundingRate,
      minimumOrderUsd: MINIMUM_ORDER_USD,
    }));
    const [only, ...others] = matches;
    // One market reads as its ticker and price, a HIP-3 one by its ticker alone ("NVDA").
    const found =
      only && !others.length
        ? `${only.name.split(":").at(-1)} ${priceLabel(only.markPx)}`
        : counted(matches.length, "market", "markets");
    return result(JSON.stringify({ markets }), { found });
  },
});
