import { describe, expect, it } from "vitest";

import { carryTake } from "./first-message";

describe("carryTake", () => {
  it("hands the dive the chat's first frame, and the chat the moment the dive lands", async () => {
    const carry = carryTake();
    const frame = { id: "first frame" } as unknown as HTMLElement;
    carry.take.arrive(frame);
    await expect(carry.arrived).resolves.toBe(frame);

    let landed = false;
    void carry.take.landed.then(() => (landed = true));
    await Promise.resolve();
    expect(landed).toBe(false);
    carry.land();
    await carry.take.landed;
    expect(landed).toBe(true);
  });
});
