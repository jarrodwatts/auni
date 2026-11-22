import { describe, expect, it } from "vitest";

import type { AuniUiMessage } from "./conversation";
import { pagesRead, picksChosen, readingTheWeb, towardsACard } from "./pages-read";

type Part = AuniUiMessage["parts"][number];

function turn(...parts: Part[]): AuniUiMessage {
  return { id: "answer", role: "assistant", parts };
}

describe("pagesRead", () => {
  const read = (id: string, ...urls: string[]): Part =>
    ({
      type: "tool-WebSearch",
      toolCallId: id,
      state: "output-available",
      input: { query: "uranium" },
      output: `Links: ${JSON.stringify(urls.map((url) => ({ title: "", url })))}\n`,
    }) as Part;
  const found = (id: string, related: string[], ...names: [string, string][]): Part =>
    ({
      type: "tool-find_instruments",
      toolCallId: id,
      state: "output-available",
      input: { query: "uranium", related },
      output: JSON.stringify({
        candidates: names.map(([name, ticker]) => ({ name, ticker, logoUrl: `/${ticker}.svg` })),
      }),
    }) as Part;

  it("is every site the turn has read, each once, in the order it read them", () => {
    expect(
      pagesRead(
        turn(
          read("w1", "https://www.cnbc.com/a", "https://reuters.com/b"),
          read("w2", "https://cnbc.com/c", "https://world-nuclear.org/d"),
        ),
      ),
    ).toEqual(
      ["cnbc.com", "reuters.com", "world-nuclear.org"].map((site) => ({ kind: "site", site })),
    );
    expect(pagesRead(turn())).toEqual([]);
  });

  it("puts the picks a market search found for what Auni named among them, as it found them", () => {
    expect(
      pagesRead(
        turn(
          read("w1", "https://cnbc.com/a"),
          found("f1", ["Cameco", "CCJ", "NexGen"], ["Cameco", "CCJ"], ["Uranium Energy", "UEC"]),
          found("f3", ["Uranium Energy"], ["Uranium Energy", "UEC"]),
          found("f2", ["Cameco"], ["Cameco", "CCJ"]),
        ),
      ),
    ).toEqual([
      { kind: "site", site: "cnbc.com" },
      { kind: "pick", name: "Cameco", logo: "/CCJ.svg" },
      { kind: "pick", name: "Uranium Energy", logo: "/UEC.svg" },
    ]);
  });
});

describe("picksChosen", () => {
  it("is the proposal's picks with the logos the searches found, and null before one", () => {
    const search = {
      type: "tool-find_instruments",
      toolCallId: "f1",
      state: "output-available",
      input: { query: "uranium" },
      output: JSON.stringify({
        candidates: [{ name: "Cameco", ticker: "CCJ", identifier: "CCJx", logoUrl: "/CCJ.svg" }],
      }),
    } as Part;
    const proposal = {
      type: "tool-propose_specialist_portfolio",
      toolCallId: "p1",
      state: "input-available",
      input: { legs: [{ tool: "stock_trade", input: { stock: "CCJx" }, name: "Cameco" }] },
    } as Part;
    expect(picksChosen(turn(search))).toBeNull();
    expect(picksChosen(turn(search, proposal))).toEqual([{ name: "Cameco", logo: "/CCJ.svg" }]);
  });
});

describe("towardsACard", () => {
  const step = (toolName: string): Part =>
    ({
      type: `tool-${toolName}`,
      toolCallId: toolName,
      state: "input-available",
      input: {},
    }) as Part;

  it("is researching once the web or the markets are read, and making once the card is", () => {
    expect(towardsACard(turn())).toBeNull();
    expect(towardsACard(turn(step("get_portfolio")))).toBeNull();
    expect(towardsACard(turn(step("WebSearch")))).toBe("researching");
    expect(towardsACard(turn(step("find_instruments")))).toBe("researching");
    expect(towardsACard(turn(step("WebSearch"), step("propose_specialist_portfolio")))).toBe(
      "making",
    );
  });
});

describe("readingTheWeb", () => {
  const step = (toolName: string, state: string): Part =>
    ({ type: `tool-${toolName}`, toolCallId: toolName + state, state, input: {} }) as Part;

  it("is a search or a page asked for and not yet had, beside any other step", () => {
    expect(readingTheWeb(turn(step("WebSearch", "input-available")))).toBe(true);
    expect(
      readingTheWeb(
        turn(step("WebFetch", "input-streaming"), step("find_picks", "input-available")),
      ),
    ).toBe(true);
    expect(readingTheWeb(turn(step("WebSearch", "output-available")))).toBe(false);
    expect(readingTheWeb(turn(step("find_picks", "input-available")))).toBe(false);
  });
});
