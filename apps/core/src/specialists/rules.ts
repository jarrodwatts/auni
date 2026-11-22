import { specialistUpdateFieldSchema, type SpecialistUpdateField } from "@auni/shared";

import type { SpecialistFields, SpecialistRow } from "../db/schema.ts";
import { usdToCents } from "../money/usd.ts";

/** The rules in plain words, as the agent reads them at the start of every turn. */
export function rulesSentence(row: SpecialistRow): string {
  return row.actMode === "within_limits"
    ? "Acts on its own: buys that fit its uninvested money and sells of what it holds run straight away; leveraged perps and anything else ask first."
    : "Asks first before every move.";
}

/**
 * True when a patch would widen what runs without a tap: letting a specialist
 * act on its own, or raising the pot of one that will. Only the owner's tap can.
 */
export function widensWhatRuns(row: SpecialistRow, patch: SpecialistFields): boolean {
  if (patch.actMode === "within_limits" && row.actMode !== "within_limits") return true;
  return (
    (patch.actMode ?? row.actMode) === "within_limits" &&
    patch.potUsd !== undefined &&
    usdToCents(patch.potUsd) > usdToCents(row.potUsd)
  );
}

/** The fields a chat edit can change, named the same on the row and the wire. */
const SPECIALIST_FIELDS = specialistUpdateFieldSchema.options;

/** Only the fields the patch really changes, before and after; empty when nothing does. */
export function fieldChanges(
  row: SpecialistRow,
  patch: SpecialistFields,
): { before: SpecialistFields; after: SpecialistFields } {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of SPECIALIST_FIELDS) {
    const next = patch[key];
    if (next === undefined || sameValue(key, row[key], next)) continue;
    before[key] = row[key];
    after[key] = next;
  }
  return { before: before as SpecialistFields, after: after as SpecialistFields };
}

function sameValue(key: SpecialistUpdateField, current: unknown, next: unknown): boolean {
  // Dollar columns come back as "100.00"; a patch may say "100".
  if (key === "potUsd") return Number(current) === Number(next);
  return current === next;
}

/** True when every field an edit set still holds the value it set, so undoing it loses nothing later. */
export function stillAsEdited(row: SpecialistRow, after: SpecialistFields): boolean {
  return Object.keys(fieldChanges(row, after).after).length === 0;
}

/** What undoing an edit writes back: exactly the fields it changed, as they were. */
export function restoredFields(update: {
  before: SpecialistFields;
  after: SpecialistFields;
}): SpecialistFields {
  return Object.fromEntries(
    SPECIALIST_FIELDS.flatMap((key) =>
      update.after[key] === undefined || update.before[key] === undefined
        ? []
        : [[key, update.before[key]]],
    ),
  ) as SpecialistFields;
}

/**
 * True when undoing an edit would leave a specialist acting on its own wider
 * than it stood before that edit: back to acting on its own with a pot raised
 * since, say. Each record keeps how it acted and its pot then; one that doesn't
 * can't say, so it's refused. Only the owner's tap can widen it.
 */
export function undoWidens(
  row: SpecialistRow,
  update: { before: SpecialistFields; after: SpecialistFields },
): boolean {
  const restored = restoredFields(update);
  if (!widensWhatRuns(row, restored)) return false;
  const { actMode, potUsd } = update.before;
  if (!actMode || !potUsd) return true;
  return widensWhatRuns({ ...row, actMode, potUsd }, { ...row, ...restored });
}

/** The receipt's lines: each changed field under its web name, values as plain strings. */
export function changeLines(update: { before: SpecialistFields; after: SpecialistFields }) {
  return SPECIALIST_FIELDS.flatMap((key) =>
    update.after[key] === undefined
      ? []
      : [
          {
            field: key,
            before: String(update.before[key] ?? "").slice(0, 160),
            after: String(update.after[key]).slice(0, 160),
          },
        ],
  );
}
