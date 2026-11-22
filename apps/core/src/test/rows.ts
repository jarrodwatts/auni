import type { SpecialistRow } from "../db/schema.ts";

/** A complete specialist row, as the database would hand one back. */
export function specialistRow(overrides: Partial<SpecialistRow> = {}): SpecialistRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    kind: "take",
    name: "Nuclear",
    purpose: "Nuclear makes a comeback",
    theme: "bolt",
    potUsd: "200.00",
    actMode: "ask_first",
    pulse: null,
    notes: null,
    report: null,
    status: "active",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    retiredAt: null,
    ...overrides,
  };
}
