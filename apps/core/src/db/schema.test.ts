import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { orderedUuid } from "./schema.ts";

describe("orderedUuid", () => {
  it("produces RFC 9562 version 7 UUIDs accepted by z.uuid()", () => {
    const id = orderedUuid();
    expect(z.uuid().safeParse(id).success).toBe(true);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("strictly increases across bursts within one millisecond and across clock rollbacks", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const base = Date.now() + 60_000;
      vi.setSystemTime(base);
      // More than 4,096 calls in one millisecond overflows the 12-bit counter cleanly.
      const burst = Array.from({ length: 4_120 }, () => orderedUuid());
      for (let i = 1; i < burst.length; i += 1) {
        expect(burst[i]! > burst[i - 1]!).toBe(true);
      }
      // Clock stepping backward still produces strictly increasing ids.
      vi.setSystemTime(base - 10_000);
      const afterRollback = orderedUuid();
      expect(afterRollback > burst.at(-1)!).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
