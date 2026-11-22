import { z } from "zod";

import {
  automationFireIdSchema,
  automationRuleIdSchema,
  messageIdSchema,
  threadIdSchema,
  timestampSchema,
} from "../shared.ts";

export const automationStatusSchema = z.enum([
  "active",
  "paused",
  "triggered",
  "expired",
  "cancelled",
  "failed",
  "deleted",
]);
export type AutomationStatus = z.infer<typeof automationStatusSchema>;

/**
 * What became of a fire. Quiet: the hub held it back (a story already told, a cooldown, the day's
 * cap). Otherwise triage judged it: wake the agent now, hold it for the daily brief, or just note
 * it. Null while it waits for triage.
 */
export const fireVerdictSchema = z.enum(["quiet", "wake", "brief", "note"]);
export type FireVerdict = z.infer<typeof fireVerdictSchema>;

/** One watch as core serves it: its source's condition, and what Auni keeps around it. */
export const automationWireSchema = z.object({
  id: automationRuleIdSchema,
  threadId: threadIdSchema,
  specialistId: z.uuid().nullable(),
  /** The app that watches (its meta names it). */
  source: z.string().min(1),
  description: z.string().min(1).max(500),
  /** The agent's note on why it matters. */
  note: z.string(),
  /** The one watch that tests the specialist's belief itself. */
  thesis: z.boolean(),
  /** In the source's own shape, which only the source reads. */
  condition: z.record(z.string(), z.unknown()),
  /** Null fires once; otherwise the least time between fires that wake the thread ("1h"). */
  repeat: z.string().nullable(),
  status: automationStatusSchema,
  /** Null watches until deleted. */
  expiresAt: timestampSchema.nullable(),
  lastFiredAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
});
export type AutomationWire = z.infer<typeof automationWireSchema>;

/** One time a watch fired past the hub: when, what triage made of it, and what Auni said. */
export const automationFireWireSchema = z.object({
  id: automationFireIdSchema,
  automationId: automationRuleIdSchema,
  description: z.string(),
  firedAt: timestampSchema,
  /** It happened while Auni was asleep or offline, and was found catching up. */
  late: z.boolean(),
  /** Never quiet here; null while triage still judges it. */
  verdict: fireVerdictSchema.nullable(),
  /** Triage's one line on why. */
  reason: z.string().nullable(),
  messageId: messageIdSchema.nullable(),
  outcome: z.string().nullable(),
});
export type AutomationFireWire = z.infer<typeof automationFireWireSchema>;
