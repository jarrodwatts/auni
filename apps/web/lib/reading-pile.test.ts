import { describe, expect, it } from "vitest";

import { nextLandingIn, nextPage, pileOf } from "./reading-pile";

const SITES = ["sec.gov", "rbccm.com", "cnbc.com", "eia.gov"];

/** Lands `count` pages in turn, as the pile does. */
function land(count: number, read = SITES.length): number[] {
  const landed: number[] = [];
  for (let at = 0; at < count; at += 1) landed.push(nextPage(landed, read));
  return landed;
}

describe("the reading pile", () => {
  it("is the owner's take alone until a page has been read", () => {
    expect(pileOf([], [])).toEqual([{ landing: 0, page: null }]);
    expect(nextLandingIn([], 0)).toBeNull();
  });

  it("lands each page in turn on the take, three pages deep", () => {
    expect(pileOf(land(1), SITES).map(({ page }) => page)).toEqual([null, "sec.gov"]);
    expect(pileOf(land(3), SITES).map(({ page }) => page)).toEqual([
      "sec.gov",
      "rbccm.com",
      "cnbc.com",
    ]);
  });

  it("goes round the pages again once all have landed, never stopping on one", () => {
    expect(pileOf(land(5), SITES).map(({ page }) => page)).toEqual([
      "cnbc.com",
      "eia.gov",
      "sec.gov",
    ]);
    expect(nextLandingIn(land(5), SITES.length)).not.toBeNull();
  });

  it("lands a page read while going round next, never behind the round", () => {
    const landed = land(6, 2);
    expect(landed).toEqual([0, 1, 0, 1, 0, 1]);
    expect(nextPage(landed, 3)).toBe(2);
    expect(nextLandingIn(landed, 3)).toBe(nextLandingIn([0], 2));
  });

  it("lands the first page at once, then each not yet on the pile sooner than one read again", () => {
    expect(nextLandingIn([], SITES.length)!).toBeLessThan(nextLandingIn(land(2), SITES.length)!);
    expect(nextLandingIn(land(2), SITES.length)!).toBeLessThan(
      nextLandingIn(land(4), SITES.length)!,
    );
  });

  it("keys each page by the landing that put it there, so a page read again lands anew", () => {
    expect(pileOf(land(6), SITES).map(({ landing }) => landing)).toEqual([4, 5, 6]);
  });
});
