import { cardLogoUrlSchema } from "@auni/shared";
import type { Address, Hex } from "viem";
import { z } from "zod";

import { counted, defineTool, result } from "../../agent/tool.ts";
import { CLOB, CONTRACTS, GAMMA, getJson } from "./http.ts";
import { toMicros, type Exchange } from "./orders.ts";

interface ClobMarket {
  readonly condition_id: string;
  readonly question: string;
  readonly tokens: readonly {
    readonly token_id: string;
    readonly outcome: string;
    readonly winner?: boolean;
  }[];
  readonly minimum_tick_size: number | string;
  readonly neg_risk?: boolean;
  readonly accepting_orders: boolean;
  readonly closed: boolean;
  readonly end_date_iso?: string | null;
  readonly image?: string;
  readonly version?: string;
}

/**
 * Where a market's orders settle and its shares live. Polymarket runs two protocols side by
 * side: the original conditional tokens, and Protocol V2, where every market new from
 * November 2026 lives. Holdings are never moved between them, so both stay supported.
 */
export interface Protocol {
  readonly version: "v1" | "v2";
  readonly exchange: Exchange;
  /** The ERC-1155 contract holding the market's shares. */
  readonly shares: Address;
  /** What the CLOB calls those shares when it refreshes a balance. */
  readonly assetType: "CONDITIONAL" | "CONDITIONAL-V2";
  /** Allowed the pUSD a buy spends, and the shares a sale sells. */
  readonly spenders: readonly Address[];
}

// A Protocol V2 position id leaves these bits clear; an original one is a hash, so has them set.
const V2_RESERVED_BITS = ((1n << 64n) - 1n) << 40n;
const isV2 = (tokenId: bigint) => (tokenId & V2_RESERVED_BITS) === 0n;

/** The ERC-1155 contract an outcome's shares live in, known from its token id alone. */
export function sharesContract(tokenId: bigint): Address {
  return isV2(tokenId) ? CONTRACTS.positionManager : CONTRACTS.conditionalTokens;
}

function protocolOf(data: ClobMarket, tokenIds: readonly bigint[]): Protocol {
  const v2 = tokenIds.length > 0 && tokenIds.every(isV2);
  // The ids decide; the CLOB's own label, where it gives one, must agree, so a market neither
  // names clearly is never traded on the wrong exchange.
  const mixed = tokenIds.some((id) => isV2(id) !== v2);
  if (mixed || (data.version !== undefined && data.version !== (v2 ? "v2" : "v1")))
    throw new Error(
      `Polymarket can't say which protocol "${data.question}" trades on, so Auni won't trade it.`,
    );
  if (v2)
    return {
      version: "v2",
      exchange: { address: CONTRACTS.exchangeV3, version: "3" },
      shares: CONTRACTS.positionManager,
      assetType: "CONDITIONAL-V2",
      spenders: [CONTRACTS.exchangeV3],
    };
  const exchange = data.neg_risk === true ? CONTRACTS.negRiskExchange : CONTRACTS.standardExchange;
  return {
    version: "v1",
    exchange: { address: exchange, version: "2" },
    shares: CONTRACTS.conditionalTokens,
    assetType: "CONDITIONAL",
    // A neg-risk order is also checked against the NegRiskAdapter: its pUSD allowance for a
    // buy, and its approval over the shares for a sale.
    spenders: data.neg_risk === true ? [exchange, CONTRACTS.negRiskAdapter] : [exchange],
  };
}

interface ResolvedMarket {
  readonly conditionId: Hex;
  readonly question: string;
  readonly tokens: readonly {
    readonly tokenId: bigint;
    readonly outcome: string;
    readonly winner: boolean;
  }[];
  readonly tickMicros: bigint;
  readonly acceptingOrders: boolean;
  readonly protocol: Protocol;
  readonly namedTokenId?: bigint;
  /** When the market is due to resolve, if Polymarket says. */
  readonly endDate?: string;
  /** The market's own picture, when Polymarket has one a card can take. */
  readonly image?: string;
}

export async function resolveMarket(market: string): Promise<ResolvedMarket> {
  const trimmed = market.trim();
  let conditionId: string;
  let namedTokenId: bigint | undefined;
  if (/^0x[0-9a-fA-F]{64}$/u.test(trimmed)) {
    conditionId = trimmed.toLowerCase();
  } else if (/^\d{10,}$/u.test(trimmed)) {
    namedTokenId = BigInt(trimmed);
    conditionId = (await getJson<{ condition_id: string }>(`${CLOB}/markets-by-token/${trimmed}`))
      .condition_id;
  } else {
    conditionId = (
      await getJson<{ conditionId: string }>(`${GAMMA}/markets/slug/${encodeURIComponent(trimmed)}`)
    ).conditionId;
  }
  const data = await getJson<ClobMarket>(`${CLOB}/markets/${conditionId}`);
  const image = cardLogoUrlSchema.safeParse(data.image);
  const tokens = data.tokens.map((token) => ({
    tokenId: BigInt(token.token_id),
    outcome: token.outcome,
    winner: token.winner === true,
  }));
  return {
    conditionId: data.condition_id.toLowerCase() as Hex,
    question: data.question,
    tokens,
    tickMicros: toMicros(String(data.minimum_tick_size)),
    acceptingOrders: data.accepting_orders && !data.closed,
    protocol: protocolOf(
      data,
      tokens.map((token) => token.tokenId),
    ),
    ...(namedTokenId === undefined ? {} : { namedTokenId }),
    ...(data.end_date_iso ? { endDate: data.end_date_iso } : {}),
    ...(image.success ? { image: image.data } : {}),
  };
}

export async function resolveOutcome(
  market: string,
  outcome?: string,
): Promise<ResolvedMarket & { readonly outcome: string; readonly tokenId: bigint }> {
  const resolved = await resolveMarket(market);
  const wanted = (outcome ?? "").trim().toLowerCase();
  const token = resolved.tokens.find((entry) =>
    resolved.namedTokenId === undefined
      ? entry.outcome.toLowerCase() === wanted
      : entry.tokenId === resolved.namedTokenId,
  );
  if (!token) {
    throw new Error(
      `"${resolved.question}" has outcomes ${resolved.tokens.map((entry) => entry.outcome).join(" and ")}; name one of them as the outcome.`,
    );
  }
  return { ...resolved, outcome: token.outcome, tokenId: token.tokenId };
}

export interface GammaMarket {
  readonly question: string;
  readonly conditionId: string;
  readonly slug: string;
  readonly groupItemTitle?: string;
  /** JSON-encoded string arrays, in outcome order. */
  readonly outcomes?: string;
  readonly outcomePrices?: string;
  readonly clobTokenIds?: string;
  readonly volume?: string;
  readonly volume24hr?: number;
  readonly endDate?: string;
  readonly closed?: boolean;
  readonly active?: boolean;
  readonly enableOrderBook?: boolean;
}

interface GammaEvent {
  readonly title: string;
  readonly slug: string;
  readonly endDate?: string;
  readonly negRisk?: boolean;
  readonly icon?: string;
  readonly image?: string;
  readonly liquidity?: number;
  readonly volume24hr?: number;
  readonly markets?: readonly GammaMarket[];
}

/** Active events matching a search, keeping only the markets Gamma says take orders now. */
export async function searchEvents(
  query: string,
): Promise<(GammaEvent & { readonly markets: readonly GammaMarket[] })[]> {
  const result = await getJson<{ events?: readonly GammaEvent[] }>(
    `${GAMMA}/public-search?${new URLSearchParams({ q: query, limit_per_type: "8", events_status: "active" })}`,
  );
  return (result.events ?? []).map((event) => ({
    ...event,
    markets: (event.markets ?? []).filter(
      (market) => market.active && !market.closed && market.enableOrderBook,
    ),
  }));
}

const marketsInput = {
  query: z
    .string()
    .min(1)
    .describe('A theme or question, e.g. "bitcoin 100k", "fed rate cut", "world cup".'),
};

export const polymarketMarkets = defineTool({
  name: "polymarket_markets",
  description:
    "Search open Polymarket prediction markets by theme. Returns each market's question, condition id and slug to trade with, outcomes with their current prices (the implied probability, in dollars per share), volume and end date.",
  inputSchema: marketsInput,
  async handler(input) {
    const markets = (await searchEvents(input.query)).flatMap((event) =>
      event.markets.map((market) => {
        const outcomes = JSON.parse(market.outcomes ?? "[]") as string[];
        const prices = JSON.parse(market.outcomePrices ?? "[]") as string[];
        return {
          event: event.title,
          question: market.question,
          conditionId: market.conditionId,
          slug: market.slug,
          outcomes: outcomes.map((name, index) => ({
            outcome: name,
            price: Number(prices[index] ?? "0"),
          })),
          volumeUsd: Math.round(Number(market.volume ?? "0")),
          endDate: market.endDate ?? event.endDate,
          negRisk: event.negRisk === true,
        };
      }),
    );
    const shown = markets.slice(0, 30);
    return result(JSON.stringify({ markets: shown }), {
      found: counted(shown.length, "market", "markets"),
    });
  },
});
