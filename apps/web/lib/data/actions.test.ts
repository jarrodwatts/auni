import { CARD_FORMAT, RETRACTED, type ActionRecordId } from "@auni/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreApiError } from "@/lib/core";

import { decideAction, NOT_REACHED, tapFailed } from "./actions";
import { decideProposal } from "./proposals";

describe("tapFailed", () => {
  // Core refuses a card drawn before cards said every permission; the card says why, not "lost".
  it("says core's words for a card it refused as out of date, and NOT_REACHED for the rest", () => {
    const outOfDate = new CoreApiError({
      message: "Core request failed with status 409",
      status: 409,
      code: "out_of_date",
      detail: RETRACTED.outOfDate,
    });
    expect(tapFailed(outOfDate)).toBe(RETRACTED.outOfDate);
    expect(tapFailed(new CoreApiError({ message: "x", status: 502 }))).toBe(NOT_REACHED);
    expect(tapFailed(new TypeError("Failed to fetch"))).toBe(NOT_REACHED);
  });
});

// A tab left open across an update keeps the web app it loaded: core allows a tap only from one
// that says it draws cards as they are now, so this web app names its format in every tap.
describe("a tap on Allow", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("names the card format this web app draws, on a single card and on a plan", async () => {
    const sent: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: 500 });
    });
    await expect(
      decideAction("7d0c0000-0000-4000-8000-0000000000aa" as ActionRecordId, "allow"),
    ).rejects.toThrow();
    await expect(decideProposal("7d0c0000-0000-4000-8000-0000000000ab", "allow")).rejects.toThrow();
    expect(sent).toEqual([{ cardFormat: CARD_FORMAT }, { cardFormat: CARD_FORMAT }]);
  });
});
