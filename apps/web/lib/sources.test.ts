import { describe, expect, it } from "vitest";

import { siteMark, stepSites } from "./sources";

const results = (urls: readonly string[]) =>
  `Web search results for query: "nvidia earnings"\n\nLinks: ${JSON.stringify(
    urls.map((url, index) => ({ title: `Page ${index}`, url })),
  )}\n\nNvidia reported…`;

describe("the sites a step read", () => {
  it("are a search's results, each site once, in the order found", () => {
    expect(
      stepSites(
        "WebSearch",
        { query: "nvidia earnings" },
        results([
          "https://www.sec.gov/a.htm",
          "https://www.sec.gov/b.htm",
          "https://www.oanda.com/x",
          "https://fxstreet.com/y",
        ]),
      ),
    ).toEqual(["sec.gov", "oanda.com", "fxstreet.com"]);
  });

  it("are at most five", () => {
    const urls = ["a", "b", "c", "d", "e", "f", "g"].map((site) => `https://${site}.com/`);
    expect(stepSites("WebSearch", {}, results(urls))).toHaveLength(5);
  });

  it("are the page a read opened", () => {
    expect(stepSites("WebFetch", { url: "https://www.reuters.com/markets/" }, "…")).toEqual([
      "reuters.com",
    ]);
  });

  it("are none while a search is under way, or for anything that isn't the web", () => {
    expect(stepSites("WebSearch", { query: "x" }, undefined)).toEqual([]);
    expect(stepSites("WebSearch", {}, "Links: not json\n")).toEqual([]);
    expect(stepSites("get_portfolio", {}, results(["https://a.com"]))).toEqual([]);
    expect(stepSites("WebFetch", { url: "javascript:alert(1)" }, "")).toEqual([]);
  });

  it("each carry the site's own mark, as core finds it", () => {
    expect(siteMark("cnbc.com")).toBe("/core/site-marks/cnbc.com");
  });
});
