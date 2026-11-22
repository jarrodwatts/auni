import { describe, expect, it } from "vitest";

import { usdc } from "@/lib/data/usdc";

import { endingLive } from "./live-end";

const usd = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));
const point = (observedAt: string, value: number, made: number) => ({
  observedAt,
  totalUsd: usdc(usd(value)),
  made: usdc(usd(made)),
});

describe("endingLive", () => {
  // A $1 buy whose fee was a cent: the number shows it, the last kept reading doesn't yet.
  const history = [
    point("2026-10-24T13:00:00.000Z", 67.72, -152.51),
    point("2026-10-24T13:22:07.000Z", 67.71, -152.52),
  ];
  const live = { value: usd(67.7), made: usd(-152.53) };

  it("ends the line in the number on screen", () => {
    const now = Date.parse("2026-10-24T13:22:08.000Z");
    const end = endingLive(history, live, now).at(-1);
    expect(end?.observedAt).toBe("2026-10-24T13:22:08.000Z");
    expect(end?.totalUsd.baseUnits).toBe(String(usd(67.7)));
    expect(end?.made.baseUnits).toBe(String(usd(-152.53)));
  });

  it("never ends before the history does, should this clock run behind core's", () => {
    const now = Date.parse("2026-10-24T13:22:06.000Z");
    expect(endingLive(history, live, now).at(-1)?.observedAt).toBe("2026-10-24T13:22:07.000Z");
  });

  it("draws nothing more without a history or a number", () => {
    expect(endingLive([], live)).toEqual([]);
    expect(endingLive(history, null)).toBe(history);
  });
});
