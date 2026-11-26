import { RETRACTED } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { askStanding } from "./ask-standing";

describe("askStanding", () => {
  it("waits for a tap until it's decided", () => {
    expect(askStanding("set_thread_autonomy", "awaiting_permission", null)).toEqual({
      kind: "waiting",
    });
  });

  it("says what an allowed ask did", () => {
    expect(askStanding("save_routine", "done", null)).toMatchObject({ label: "Saved" });
    expect(askStanding("set_thread_autonomy", "done", null)).toEqual({
      kind: "ended",
      label: "Updated",
      tone: "done",
    });
  });

  it("says why one couldn't apply, and when it was declined, replaced or taken back", () => {
    expect(
      askStanding(
        "set_thread_autonomy",
        "failed",
        "The thread was archived before you allowed this.",
      ),
    ).toMatchObject({
      label: "The thread was archived before you allowed this.",
      tone: "quiet",
    });
    expect(askStanding("set_thread_autonomy", "cancelled", null)).toMatchObject({
      label: "Declined",
    });
    expect(askStanding("set_thread_autonomy", "replaced", null)).toMatchObject({
      label: "Replaced by a newer card",
    });
    expect(askStanding("set_thread_autonomy", "retracted", RETRACTED.stale)).toMatchObject({
      label: RETRACTED.stale,
    });
  });
});
