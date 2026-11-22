import { RETRACTED } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { askStanding } from "./ask-standing";

describe("askStanding", () => {
  it("waits for a tap until it's decided", () => {
    expect(askStanding("update_specialist", "awaiting_permission", null)).toEqual({
      kind: "waiting",
    });
  });

  it("says what an allowed ask did", () => {
    expect(askStanding("start_specialist", "done", null)).toMatchObject({ label: "Started" });
    expect(askStanding("update_specialist", "done", null)).toEqual({
      kind: "ended",
      label: "Changed",
      tone: "done",
    });
  });

  it("says why one couldn't apply, and when it was declined, replaced or taken back", () => {
    expect(
      askStanding("update_specialist", "failed", "It retired before you allowed this."),
    ).toMatchObject({
      label: "It retired before you allowed this.",
      tone: "quiet",
    });
    expect(askStanding("update_specialist", "cancelled", null)).toMatchObject({
      label: "You said not now",
    });
    expect(askStanding("update_specialist", "replaced", null)).toMatchObject({
      label: "Replaced by a newer card",
    });
    expect(askStanding("update_specialist", "retracted", RETRACTED.stale)).toMatchObject({
      label: RETRACTED.stale,
    });
  });
});
