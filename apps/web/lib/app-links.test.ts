import { describe, expect, it } from "vitest";

import { FUNDING_DIALOG_PARAM, fundingAsked, fundingDialogHref } from "./app-links";

describe("Add money's link", () => {
  it("opens for anything, or for the whole dollars a card needs", () => {
    expect(fundingDialogHref("/app/chat/t", "")).toBe(`/app/chat/t?${FUNDING_DIALOG_PARAM}=open`);
    expect(fundingDialogHref("/app/chat/t", "a=1", 50)).toBe(
      `/app/chat/t?a=1&${FUNDING_DIALOG_PARAM}=50`,
    );
  });

  it("says what it was opened for, and is closed for anything else", () => {
    expect(fundingAsked("open")).toEqual({ need: null });
    expect(fundingAsked("50")).toEqual({ need: "50" });
    for (const value of [null, "", "0", "-5", "12.5", "fifty"])
      expect(fundingAsked(value)).toBeNull();
  });
});
