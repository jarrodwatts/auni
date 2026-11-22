import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forgetRegion, polymarketRegion, regionRule } from "./region.ts";

/** A recorded answer of polymarket.com/api/geoblock (see each file's `from`). */
const answer = (name: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`fixtures/geoblock/${name}.json`, import.meta.url), "utf8"),
    ) as {
      answer: { blocked: boolean; country: string; region: string };
    }
  ).answer;

describe("what Polymarket's region check means for the owner", () => {
  it("takes new bets where Polymarket isn't blocking this machine", () => {
    expect(regionRule(answer("allowed"))).toBeNull();
  });

  it("takes new bets where only Polymarket's website is close-only, not the API Auni uses", () => {
    expect(regionRule(answer("blocked-nl"))).toBeNull();
  });

  it("says no new bets, and what still works, from a close-only place", () => {
    expect(regionRule(answer("blocked-au"))).toEqual({
      short: "No new bets from here",
      says: "Polymarket takes no new bets where this Auni runs (Australia), and Auni keeps to that. Selling a bet you hold there, and bringing your Polymarket cash home, still work.",
    });
    expect(regionRule(answer("blocked-sg"))?.says).toContain("runs (Singapore)");
    expect(regionRule(answer("blocked-us"))?.says).toContain("runs (United States)");
  });

  it("says nothing trades where Polymarket takes no orders at all", () => {
    expect(regionRule({ blocked: true, country: "IR" })).toEqual({
      short: "No trading from here",
      says: "Polymarket takes no orders where this Auni runs (Iran), so no bet can be placed or sold here, and Auni keeps to that.",
    });
  });

  it("never suggests a way round the rule", () => {
    for (const name of ["blocked-au", "blocked-sg", "blocked-us"])
      expect(regionRule(answer(name))?.says).not.toMatch(/vpn|proxy|another|elsewhere|move/iu);
  });
});

describe("asking Polymarket", () => {
  const asked = vi.fn<(url: string) => Promise<Response>>();
  beforeEach(() => {
    forgetRegion();
    asked.mockReset();
    vi.stubGlobal("fetch", (url: string) => asked(url));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("asks once and keeps the answer a while", async () => {
    asked.mockImplementation(async () => Response.json(answer("blocked-au")));
    expect((await polymarketRegion())?.short).toBe("No new bets from here");
    expect((await polymarketRegion())?.short).toBe("No new bets from here");
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenCalledWith("https://polymarket.com/api/geoblock");
  });

  it("changes nothing when Polymarket can't be asked, and asks again a minute later", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    asked.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await polymarketRegion()).toBeNull();
    expect(await polymarketRegion()).toBeNull();
    expect(asked).toHaveBeenCalledTimes(1);

    asked.mockImplementation(async () => Response.json(answer("blocked-au")));
    vi.advanceTimersByTime(61_000);
    expect((await polymarketRegion())?.short).toBe("No new bets from here");
  });

  it("reads an answer it doesn't understand as no answer", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    asked.mockImplementation(async () => new Response("<html>Checking your browser</html>"));
    expect(await polymarketRegion()).toBeNull();
  });
});
