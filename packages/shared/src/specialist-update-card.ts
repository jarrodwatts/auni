import { z } from "zod";

import { cardBaseSchema } from "./card-base.ts";
import { specialistIdSchema, timestampSchema } from "./shared.ts";

/** A field one chat edit can change; values travel as plain strings ("within_limits", "150.00"). */
export const specialistUpdateFieldSchema = z.enum(["purpose", "name", "potUsd", "actMode"]);
export type SpecialistUpdateField = z.infer<typeof specialistUpdateFieldSchema>;

const specialistUpdateChangeSchema = z.strictObject({
  field: specialistUpdateFieldSchema,
  before: z.string().max(160),
  after: z.string().max(160),
});

/**
 * The one-line receipt a chat edit to a specialist leaves in its thread
 * ("Money updated · $1,000 → $1,500 behind it", with Undo). `POST
 * /specialists/:specialistId/updates/:id/undo` restores the before values;
 * `GET` on the same path (without /undo) says whether it has been undone.
 */
export const specialistUpdateCardSchema = cardBaseSchema.extend({
  kind: z.literal("specialist_update"),
  /** The update record; the card's own id is the same uuid. */
  updateId: z.uuid(),
  specialistId: specialistIdSchema,
  specialistName: z.string().trim().min(1).max(24),
  changes: z.array(specialistUpdateChangeSchema).min(1).max(12),
});
export type SpecialistUpdateCardWire = z.infer<typeof specialistUpdateCardSchema>;

/** One chat edit's record, as the receipt reads it: what changed, and whether it was undone. */
export const specialistUpdateWireSchema = z.object({
  id: z.uuid(),
  specialistId: specialistIdSchema,
  changes: z.array(specialistUpdateChangeSchema),
  undoneAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type SpecialistUpdateWire = z.infer<typeof specialistUpdateWireSchema>;
