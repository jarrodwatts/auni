import { LINE_WIDTH_PX, lineFits, lineWidth } from "@auni/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requestComposerFocus } from "./composer";
import { pickStartingPoint, seenOn, WORDS_START } from "./starting-points";

vi.mock("./composer", () => ({ requestComposerFocus: vi.fn() }));

// Core shows a starting point only when `lineFits` measures its line within LINE_WIDTH_PX on a
// phone 360 wide (@auni/shared). Here the rows' layout is held to leave that room, and the
// measure to the lines it must take and refuse.

/** The narrowest phone, its page gutters, and room left over so a line never touches the edge. */
const PHONE = 360;
const GUTTERS = 2 * 16;
const MARGIN = 6;

describe("a starting point's line on a 360 wide phone", () => {
  it("has the room core measures lines against", () => {
    expect(PHONE - GUTTERS - WORDS_START - MARGIN).toBeGreaterThanOrEqual(LINE_WIDTH_PX);
  });

  it("takes the widest lines core and the demo write", () => {
    for (const [statement, action] of [
      ["MSTR fell 12.4% today.", "What's next?"],
      ["NVDA fell 12.4% now.", "What's behind?"],
      // Where core's fullest wording of a held coin is too wide, it says the next one.
      ["MSTR is down 12.4%.", "What next?"],
      ["$9,839 sits in cash.", "Put it to work"],
      ["Your wallet is empty.", "Get started"],
      ["You have $19,150.03.", "Look it over"],
      ["Bitcoin above $150K?", "14%, really?"],
    ] as const)
      expect(lineFits({ statement, action })).toBe(true);
  });

  it("refuses a line too wide for the row, however few its characters", () => {
    // 33 and 34 characters, no more than the widest it takes, but four capitals wide: about 275
    // and 279px on an iPhone.
    for (const wide of [
      { statement: "Your MSTR is down 12.4%.", action: "What next?" },
      { statement: "MSTR is down 12.4% today.", action: "What now?" },
    ]) {
      expect(lineWidth(wide)).toBeGreaterThan(LINE_WIDTH_PX);
      expect(lineFits(wide)).toBe(false);
    }
  });

  it("refuses a line with a blank in it, cut short or left to be filled in", () => {
    for (const statement of ["AI bubble burst by...?", "Anthropic IPO by __?", "Fed decision in…"])
      expect(lineFits({ statement, action: "Weigh it up" })).toBe(false);
  });
});

// A click sent a point's words at once while a tap put them in the box, so a desktop owner sent
// words they never read (2026-11-25 council). Every device now puts them in the box.
describe("picking a starting point", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(requestComposerFocus).mockClear();
  });

  it("puts its words in the new chat's box, to read and send, by mouse, key or touch alike", () => {
    const prompt = "Test a December cut at 66%: what would you do?";
    for (const coarse of [false, true]) {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      vi.stubGlobal("matchMedia", () => ({ matches: coarse }));
      pickStartingPoint({ prompt });
      expect(requestComposerFocus).toHaveBeenLastCalledWith("new", prompt, true);
      expect(fetch).not.toHaveBeenCalled();
    }
    expect(requestComposerFocus).toHaveBeenCalledTimes(2);
  });
});

describe("where a starting point's claim came from", () => {
  const at = "2026-11-26T02:05:00.000Z";
  const clock = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  it("names the outside source and when it was read, before the owner sends it", () => {
    const market = { app: "polymarket", label: "Will the Fed cut in December?", link: null };
    expect(seenOn([market], at)).toBe(`Polymarket at ${clock}`);
    const prices = { app: "prices", label: "BTC on Hyperliquid", link: null };
    const money = { app: "auni", label: "Your money", link: "/app" };
    expect(seenOn([prices, money, market], at)).toBe(
      `BTC on Hyperliquid and Polymarket at ${clock}`,
    );
  });

  it("says nothing for a point about the owner's own money", () => {
    expect(seenOn([{ app: "auni", label: "Your cash", link: "/app" }], at)).toBeNull();
  });
});
