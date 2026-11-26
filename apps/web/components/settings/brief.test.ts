import { describe, expect, it } from "vitest";

import { briefChoice, briefFor } from "./brief";

describe("the daily brief's schedule", () => {
  it("reads each schedule as the choice Settings shows", () => {
    expect(briefChoice(null)).toBe("off");
    expect(briefChoice({ every: "day", at: "08:00" })).toBe("day");
    expect(briefChoice({ every: ["fri", "mon", "tue", "wed", "thu"], at: "08:00" })).toBe(
      "weekdays",
    );
    expect(briefChoice({ every: ["sat"], at: "08:00" })).toBe("days");
    expect(briefChoice({ every: "month", day: 3, at: "08:00" })).toBe("month");
  });

  it("keeps the days or the date the owner set in chat when only the time changes", () => {
    expect(briefFor("days", "09:30", { every: ["sat", "sun"], at: "08:00" })).toEqual({
      every: ["sat", "sun"],
      at: "09:30",
    });
    expect(briefFor("month", "07:00", { every: "month", day: 15, at: "08:00" })).toEqual({
      every: "month",
      day: 15,
      at: "07:00",
    });
    expect(briefFor("weekdays", "08:00", null)).toEqual({
      every: ["mon", "tue", "wed", "thu", "fri"],
      at: "08:00",
    });
    expect(briefFor("off", "08:00", { every: "day", at: "08:00" })).toBeNull();
  });
});
