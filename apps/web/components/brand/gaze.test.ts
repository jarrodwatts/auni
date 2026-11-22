import { describe, expect, it } from "vitest";

import { gaze } from "./gaze";

describe("gaze", () => {
  it("looks straight ahead at a point it's on", () => {
    expect(gaze(0, 0, 240)).toEqual({ x: 0, y: 0 });
  });

  it("turns all the way toward a point far off", () => {
    const { x, y } = gaze(300, 400, 240);
    expect(x).toBeCloseTo(0.6);
    expect(y).toBeCloseTo(0.8);
  });

  it("turns only part way toward a point close by", () => {
    const { x, y } = gaze(60, 0, 240);
    expect(x).toBeCloseTo(0.25);
    expect(y).toBe(0);
  });
});
