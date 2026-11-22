import {
  specialistUpdateWireSchema,
  specialistWireSchema,
  type SpecialistId,
  type SpecialistUpdateWire,
  type UpdateSpecialistRequest,
} from "@auni/shared";
import { z } from "zod";

import { CoreApiError, requestCore } from "@/lib/core";
import { toSpecialist } from "@/lib/data/specialists";
import type { Specialist } from "@/lib/data/views";

/**
 * Changing a specialist by hand (the rules dialog, rename) and undoing a chat
 * edit from its receipt. Chat edits themselves happen in core, where the agent
 * calls update_specialist; this side only reads and undoes their records.
 */

/** One chat edit's record: what it changed, and whether it has been undone. */
type SpecialistUpdateRecord = SpecialistUpdateWire;

/**
 * Why an undo was refused: a later change touched the same fields, it was
 * undone, it retired, or it would let it act on its own wider than it stood then.
 */
const UNDO_REFUSALS = ["superseded", "already_undone", "retired", "widens"] as const;
type UndoRefusal = (typeof UNDO_REFUSALS)[number];

type UndoOutcome =
  | {
      readonly status: "undone";
      readonly update: SpecialistUpdateRecord;
      readonly specialist: Specialist;
    }
  | { readonly status: UndoRefusal };

/** Absent fields stay as they are. Resolves to the specialist as core now has it. */
export async function updateSpecialist(
  specialistId: SpecialistId,
  patch: UpdateSpecialistRequest,
): Promise<Specialist> {
  const body = z.object({ specialist: specialistWireSchema }).parse(
    await requestCore(`specialists/${specialistId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  );
  return toSpecialist(body.specialist);
}

export async function readSpecialistUpdate(
  specialistId: SpecialistId,
  updateId: string,
  signal?: AbortSignal,
): Promise<SpecialistUpdateRecord> {
  const body = z.object({ update: specialistUpdateWireSchema }).parse(
    await requestCore(`specialists/${specialistId}/updates/${updateId}`, {
      method: "GET",
      signal,
    }),
  );
  return body.update;
}

function undoRefusal(error: unknown): UndoRefusal | null {
  if (!(error instanceof CoreApiError) || error.status !== 409) return null;
  return UNDO_REFUSALS.find((code) => code === error.code) ?? null;
}

/** Puts back what one chat edit replaced. A 409 refusal is an outcome, not an error. */
export async function undoSpecialistUpdate(
  specialistId: SpecialistId,
  updateId: string,
): Promise<UndoOutcome> {
  let raw: unknown;
  try {
    raw = await requestCore(`specialists/${specialistId}/updates/${updateId}/undo`, {
      method: "POST",
    });
  } catch (error) {
    const refusal = undoRefusal(error);
    if (refusal) return { status: refusal };
    throw error;
  }
  const body = z
    .object({ update: specialistUpdateWireSchema, specialist: specialistWireSchema })
    .parse(raw);
  return { status: "undone", update: body.update, specialist: toSpecialist(body.specialist) };
}
