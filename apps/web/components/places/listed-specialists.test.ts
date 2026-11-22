import { describe, expect, it } from "vitest";

import type { PlaceKey } from "@/lib/data/places";
import type { Specialist, Thread } from "@/lib/data/views";

import { listedSpecialists } from "./listed-specialists";

const specialist = (id: string, status: Specialist["status"]) => ({ id, status }) as Specialist;
const moved = (id: string, updatedAt: string) => [id as PlaceKey, { updatedAt } as Thread] as const;

describe("listedSpecialists", () => {
  it("keeps retired ones below the open ones, the latest to move first", () => {
    const listed = listedSpecialists(
      [
        specialist("robots", "retired"),
        specialist("nuclear", "active"),
        specialist("peptides", "retired"),
        specialist("gold", "active"),
      ],
      new Map([moved("robots", "2026-10-01T00:00:00Z"), moved("peptides", "2026-10-09T00:00:00Z")]),
    );
    expect(listed.map(({ id }) => id)).toEqual(["nuclear", "gold", "peptides", "robots"]);
  });

  it("drops a retired one once its conversation is archived", () => {
    const listed = listedSpecialists(
      [specialist("nuclear", "active"), specialist("robots", "retired")],
      new Map(),
    );
    expect(listed.map(({ id }) => id)).toEqual(["nuclear"]);
  });
});
