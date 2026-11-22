import { describe, expect, it, vi } from "vitest";

import { CONTRACTS, getJson } from "./http.ts";
import { polymarketMarkets, resolveMarket } from "./markets.ts";

vi.mock(import("./http.ts"), async (original) => ({ ...(await original()), getJson: vi.fn() }));

// A Protocol V2 market and an original one, as the CLOB described them on 2026-10-24.
const V2_CONDITION = "0x01e64a3b41c057c976f9b5de07e357c99e000000000000000000000000000000";
const V2_YES = "859200000273234893217704100561460298679196827126852708541873133663178194944";
const V2_NO = "859200000273234893217704100561460298679196827126852708541873133663178194945";
const V1_YES = "32338220190071351435772801779725302244575775216413325951443816017994629993401";
const V1_NO = "55115078421062885512539156303747803058407616201213034911037320915726138659123";

function clobMarket(fields: {
  readonly tokens: readonly string[];
  readonly version?: string;
  readonly negRisk?: boolean;
}) {
  return {
    condition_id: V2_CONDITION,
    question: "Cayirova vs Bursaspor",
    tokens: fields.tokens.map((token_id, index) => ({ token_id, outcome: index ? "No" : "Yes" })),
    minimum_tick_size: 0.01,
    neg_risk: fields.negRisk ?? false,
    accepting_orders: true,
    closed: false,
    ...(fields.version === undefined ? {} : { version: fields.version }),
  };
}

function resolving(market: ReturnType<typeof clobMarket>) {
  vi.mocked(getJson).mockResolvedValueOnce(market);
  return resolveMarket(V2_CONDITION);
}

describe("which Polymarket protocol a market trades on", () => {
  it("routes a V2 market to ExchangeV3 and the PositionManager", async () => {
    const market = await resolving(clobMarket({ tokens: [V2_YES, V2_NO], version: "v2" }));
    expect(market.protocol).toEqual({
      version: "v2",
      exchange: { address: CONTRACTS.exchangeV3, version: "3" },
      shares: CONTRACTS.positionManager,
      assetType: "CONDITIONAL-V2",
      spenders: [CONTRACTS.exchangeV3],
    });
  });

  it("keeps an original neg-risk market on its own exchange, with the NegRiskAdapter", async () => {
    const market = await resolving(
      clobMarket({ tokens: [V1_YES, V1_NO], version: "v1", negRisk: true }),
    );
    expect(market.protocol).toEqual({
      version: "v1",
      exchange: { address: CONTRACTS.negRiskExchange, version: "2" },
      shares: CONTRACTS.conditionalTokens,
      assetType: "CONDITIONAL",
      spenders: [CONTRACTS.negRiskExchange, CONTRACTS.negRiskAdapter],
    });
  });

  it("goes by the ids when the CLOB gives no label", async () => {
    const market = await resolving(clobMarket({ tokens: [V2_YES, V2_NO] }));
    expect(market.protocol.version).toBe("v2");
  });

  it("won't trade a market whose label and ids disagree", async () => {
    await expect(resolving(clobMarket({ tokens: [V2_YES, V2_NO], version: "v1" }))).rejects.toThrow(
      "can't say which protocol",
    );
    await expect(resolving(clobMarket({ tokens: [V2_YES, V1_NO] }))).rejects.toThrow(
      "can't say which protocol",
    );
  });
});

describe("polymarket_markets", () => {
  it("counts the open markets it found", async () => {
    vi.mocked(getJson).mockResolvedValueOnce({
      events: [
        {
          title: "Fed decision in December",
          markets: [
            { question: "Will the Fed cut?", active: true, closed: false, enableOrderBook: true },
            { question: "Settled already?", active: true, closed: true, enableOrderBook: true },
          ],
        },
      ],
    });
    const out = await polymarketMarkets.handler({ query: "fed" });
    expect(out.structuredContent?.found).toBe("1 market");
  });
});
