import type { specialistUpdateCardSchema, specialistUpdateWireSchema } from "@auni/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { z } from "zod";

import { db } from "../db/client.ts";
import {
  specialists,
  specialistUpdates,
  type SpecialistRow,
  type SpecialistUpdateRow,
} from "../db/schema.ts";
import {
  changeLines,
  fieldChanges,
  restoredFields,
  stillAsEdited,
  undoWidens,
  widensWhatRuns,
} from "./rules.ts";
import { applySpecialistPatch, type SpecialistPatch } from "./specialists.ts";

/**
 * A chat edit: applies the patch and, when it changed a field the owner can
 * see, records before and after so the receipt it leaves can be undone. A
 * pulse rewrite alone leaves no record. The agent never widens what runs without
 * a tap, whoever started the turn: a patch that would is refused whole, checked
 * against the row as it is now, and the owner is asked on a card instead.
 */
export async function editSpecialist(
  context: { readonly threadId: string },
  specialist: SpecialistRow,
  patch: SpecialistPatch,
): Promise<{ row: SpecialistRow; update: SpecialistUpdateRow | null } | "widens" | undefined> {
  return db.transaction(async (tx) => {
    // Read under lock, so the before values are the ones this edit replaces.
    const [current] = await tx
      .select()
      .from(specialists)
      .where(eq(specialists.id, specialist.id))
      .for("update");
    if (!current || current.status === "retired") return undefined;
    if (widensWhatRuns(current, patch)) return "widens";
    const changes = fieldChanges(current, patch);
    const row = await applySpecialistPatch(tx, specialist.id, patch);
    if (!row) return undefined;
    if (Object.keys(changes.after).length === 0) return { row, update: null };
    const [update] = await tx
      .insert(specialistUpdates)
      .values({
        specialistId: row.id,
        threadId: context.threadId,
        after: changes.after,
        // How it acted then too, so undoing this can't leave it acting on its own wider.
        before: { ...changes.before, actMode: current.actMode, potUsd: current.potUsd },
      })
      .returning();
    return { row, update: update ?? null };
  });
}

/** The receipt card a chat edit leaves under the agent's reply. */
export function specialistUpdateCard(
  update: SpecialistUpdateRow,
  specialist: SpecialistRow,
): z.input<typeof specialistUpdateCardSchema> {
  return {
    id: update.id,
    kind: "specialist_update",
    title: `${specialist.name} updated`,
    updatedAt: update.createdAt.toISOString(),
    updateId: update.id,
    specialistId: specialist.id,
    specialistName: specialist.name,
    changes: changeLines(update),
  };
}

export function specialistUpdateWire(
  update: SpecialistUpdateRow,
): z.input<typeof specialistUpdateWireSchema> {
  return {
    id: update.id,
    specialistId: update.specialistId,
    changes: changeLines(update),
    undoneAt: update.undoneAt?.toISOString() ?? null,
    createdAt: update.createdAt.toISOString(),
  };
}

export async function specialistUpdateById(
  specialistId: string,
  updateId: string,
): Promise<SpecialistUpdateRow | undefined> {
  const [row] = await db
    .select()
    .from(specialistUpdates)
    .where(
      and(eq(specialistUpdates.id, updateId), eq(specialistUpdates.specialistId, specialistId)),
    );
  return row;
}

type UndoOutcome =
  | { readonly status: "undone"; readonly update: SpecialistUpdateRow; readonly row: SpecialistRow }
  | { readonly status: "not_found" | "already_undone" | "retired" | "superseded" | "widens" };

/**
 * Puts back what one chat edit replaced. Refused when a later change has
 * since touched any of the same fields: undoing then would silently discard it.
 * Refused too when it would leave the specialist acting on its own wider than
 * it stood before the edit, which only the owner's tap on the switch or a card can.
 */
export async function undoSpecialistUpdate(
  specialistId: string,
  updateId: string,
): Promise<UndoOutcome> {
  return db.transaction(async (tx) => {
    const [update] = await tx
      .select()
      .from(specialistUpdates)
      .where(
        and(eq(specialistUpdates.id, updateId), eq(specialistUpdates.specialistId, specialistId)),
      )
      .for("update");
    if (!update) return { status: "not_found" as const };
    if (update.undoneAt) return { status: "already_undone" as const };
    const [current] = await tx
      .select()
      .from(specialists)
      .where(eq(specialists.id, specialistId))
      .for("update");
    if (!current || current.status === "retired") return { status: "retired" as const };
    if (!stillAsEdited(current, update.after)) return { status: "superseded" as const };
    if (undoWidens(current, update)) return { status: "widens" as const };
    const row = await applySpecialistPatch(tx, specialistId, restoredFields(update));
    if (!row) return { status: "retired" as const };
    const [undone] = await tx
      .update(specialistUpdates)
      .set({ undoneAt: sql`now()` })
      .where(and(eq(specialistUpdates.id, update.id), isNull(specialistUpdates.undoneAt)))
      .returning();
    if (!undone) return { status: "already_undone" as const };
    return { status: "undone" as const, update: undone, row };
  });
}
