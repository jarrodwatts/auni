import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { polymarketFacts } from "./facts.ts";
import { getJson } from "./http.ts";

vi.mock(import("./http.ts"), async (original) => ({ ...(await original()), getJson: vi.fn() }));

// Gamma's ten most traded events outside sports on 2026-11-08, cut to the fields read: each
// event's likeliest open markets and one closed one.
const TOP_EVENTS: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/gamma-top-events.json", import.meta.url), "utf8"),
);

describe("polymarketFacts", () => {
  it("asks Gamma for its most traded open events outside sports", async () => {
    vi.mocked(getJson).mockResolvedValueOnce([]);
    await polymarketFacts();
    const url = new URL(vi.mocked(getJson).mock.calls.at(-1)![0]);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      active: "true",
      closed: "false",
      order: "volume24hr",
      ascending: "false",
      exclude_tag_id: "1",
    });
  });

  it("tells the top five questions still in doubt, each at its likeliest outcome and with its picture", async () => {
    vi.mocked(getJson).mockResolvedValueOnce(TOP_EVENTS);
    const facts = await polymarketFacts();
    expect(facts).toHaveLength(5);
    expect(facts[0]).toEqual({
      text: 'On Polymarket, "Prime Minister of Israel after the next election?" has Gadi Eizenkot at 71%, with $1M traded today.',
      label: "Prime Minister of Israel after the next election?",
      link: "https://polymarket.com/event/who-will-be-the-next-prime-minister-of-israel-after-the-next-election",
      image:
        "https://polymarket-upload.s3.us-east-2.amazonaws.com/who-will-be-the-next-prime-minister-of-israel-after-the-2026-election-lWDmU0z7U_Vj.png",
      // Too long to ask whole on one row, so it offers no start: it is never cut short.
      starts: [],
    });
    for (const { starts } of facts)
      for (const { statement, action } of starts)
        expect(`${statement} ${action}`).not.toContain("…");
    // The ceasefire's nearer dates are priced past 97%, all but settled, so it is told by the
    // likeliest date still in doubt.
    expect(facts[1]!.text).toBe(
      'On Polymarket, "Israel x Iran ceasefire continues through...?" has November 15 at 89%, with $958K traded today.',
    );
  });

  it("tells a single question at its chance of Yes", async () => {
    vi.mocked(getJson).mockResolvedValueOnce([
      {
        title: "Fed decision in December?",
        slug: "fed-december",
        markets: [
          {
            question: "Will the Fed cut rates in December?",
            conditionId: "0x1",
            slug: "fed-cut-december",
            outcomes: '["Yes", "No"]',
            outcomePrices: '["0.62", "0.38"]',
            active: true,
            closed: false,
            enableOrderBook: true,
          },
        ],
      },
    ]);
    expect((await polymarketFacts())[0]!.text).toBe(
      'On Polymarket, "Will the Fed cut rates in December?" is at 62% Yes.',
    );
  });

  it("asks no question with a blank left in its title", async () => {
    const market = (question: string) => ({
      question,
      conditionId: "0x3",
      slug: "blank",
      outcomes: '["Yes", "No"]',
      outcomePrices: '["0.31", "0.69"]',
      active: true,
      closed: false,
      enableOrderBook: true,
    });
    vi.mocked(getJson).mockResolvedValueOnce([
      {
        title: "AI bubble burst by...?",
        slug: "ai-bubble",
        markets: [market("AI bubble burst by...?")],
      },
      {
        title: "Anthropic IPO by __?",
        slug: "anthropic-ipo",
        markets: [market("Anthropic IPO by June 30?"), market("Anthropic IPO by December 31?")],
      },
    ]);
    const facts = await polymarketFacts();
    expect(facts).toHaveLength(2);
    for (const { starts } of facts) expect(starts).toEqual([]);
  });

  it("asks a short question whole, at its chance", async () => {
    vi.mocked(getJson).mockResolvedValueOnce([
      {
        title: "Bitcoin above $150K?",
        slug: "bitcoin-150k",
        markets: [
          {
            question: "Bitcoin above $150K?",
            conditionId: "0x2",
            slug: "bitcoin-150k",
            outcomes: '["Yes", "No"]',
            outcomePrices: '["0.14", "0.86"]',
            active: true,
            closed: false,
            enableOrderBook: true,
          },
        ],
      },
    ]);
    const [fact] = await polymarketFacts();
    expect(fact!.starts.map(({ statement, action }) => `${statement} ${action}`)).toEqual([
      "Bitcoin above $150K? 14%, really?",
    ]);
  });
});
