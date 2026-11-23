import { describe, expect, it } from "vitest";

import {
  formatLiveElapsed,
  formatSettledDuration,
  formatStepDuration,
  formatWorkDuration,
} from "./work-clock";

describe("formatStepDuration", () => {
  it("formats sub-second steps in rounded ms and short steps to tenths of a second", () => {
    expect(formatStepDuration(423)).toBe("420ms");
    expect(formatStepDuration(758)).toBe("760ms");
    expect(formatStepDuration(1_240)).toBe("1.2s");
    expect(formatStepDuration(3_000)).toBe("3.0s");
    expect(formatStepDuration(14_200)).toBe("14s");
  });
});

describe("formatLiveElapsed", () => {
  it("stays silent under one second and ticks whole seconds after", () => {
    expect(formatLiveElapsed(null, 5_000)).toBe("");
    expect(formatLiveElapsed(5_000, 5_600)).toBe("");
    expect(formatLiveElapsed(5_000, 6_000)).toBe("1s");
    expect(formatLiveElapsed(5_000, 7_400)).toBe("2s");
    expect(formatLiveElapsed(5_000, 70_000)).toBe("1m 5s");
  });
});

describe("formatSettledDuration", () => {
  it("reports crisp tenths under 10s, whole seconds beyond, and null when absent", () => {
    expect(formatSettledDuration(undefined)).toBeNull();
    expect(formatSettledDuration(0)).toBeNull();
    expect(formatSettledDuration(3_010)).toBe("3.0s");
    expect(formatSettledDuration(12_400)).toBe("12s");
  });
});

describe("formatWorkDuration", () => {
  it("formats sub-second, second, and minute durations", () => {
    expect(formatWorkDuration(500)).toBe("<1s");
    expect(formatWorkDuration(65_000)).toBe("1m 5s");
  });
});
