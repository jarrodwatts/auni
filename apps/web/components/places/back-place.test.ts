import { describe, expect, it } from "vitest";

import { CHATS_HREF, NEEDS_YOU_HREF } from "@/lib/app-links";

import { backFrom, backPlace, noteOpenedFrom } from "./back-place";

describe("backFrom", () => {
  it("goes back to Needs you from a chat opened there, so the next card is one tap away", () => {
    expect(backFrom(NEEDS_YOU_HREF)).toEqual({ href: NEEDS_YOU_HREF, label: "Back to Needs you" });
  });

  it("goes back to Chats from anywhere else, or when nothing was noted", () => {
    expect(backFrom(CHATS_HREF).href).toBe(CHATS_HREF);
    expect(backFrom("/app").href).toBe(CHATS_HREF);
    expect(backFrom(null).href).toBe(CHATS_HREF);
  });

  it("follows the last place a chat was opened from", () => {
    noteOpenedFrom(NEEDS_YOU_HREF);
    expect(backPlace().href).toBe(NEEDS_YOU_HREF);
    noteOpenedFrom(CHATS_HREF);
    expect(backPlace().href).toBe(CHATS_HREF);
  });
});
