import { describe, expect, it } from "vitest";

import { FUNDING_DIALOG_PARAM, fundingAsked, fundingDialogHref } from "./app-links";

describe("Add money's link", () => {
  it("opens for anything, or for the dollars a card is short of and the network it's short on", () => {
    expect(fundingDialogHref("/app/chat/t", "")).toBe(`/app/chat/t?${FUNDING_DIALOG_PARAM}=open`);
    expect(fundingDialogHref("/app/chat/t", "a=1", { usd: "50", chain: "base" })).toBe(
      `/app/chat/t?a=1&${FUNDING_DIALOG_PARAM}=50-base`,
    );
  });

  it("says what it was opened for, and is closed for anything else", () => {
    expect(fundingAsked("open")).toEqual({ need: null });
    expect(fundingAsked("50-base")).toEqual({ need: { usd: "50", chain: "base" } });
    // Dollars alone say nothing of where they're needed, and no card is short off its cash networks.
    for (const value of [null, "", "50", "0-base", "-5-base", "12.5-base", "fifty", "50-ethereum"])
      expect(fundingAsked(value)).toBeNull();
  });
});
