import { z } from "zod";

import { dollarsSchema } from "./money.ts";
import { specialistIdSchema, threadIdSchema, timestampSchema } from "./shared.ts";

/** One holding as a person reads it, on GET /portfolio and GET /specialists alike. */
export const holdingWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Shares, side, or venue: "0.52 shares", "Polymarket · Yes, 12 shares". */
  detail: z.string(),
  /** A web-served path or a reviewed https logo; null shows the name's initial. */
  logoUrl: z.string().nullable(),
  usdValue: dollarsSchema,
  /** Since the person's midnight, at today's quantity; null when no price history was readable. */
  todayChangeUsd: dollarsSchema.nullable(),
});
export type HoldingWire = z.infer<typeof holdingWireSchema>;

/**
 * How Auni runs one specialist. The "How Auni acts" dialog, the pane's chip
 * and chat all edit it, and the permission gate enforces it.
 */
export const specialistRulesWireSchema = z.object({
  /**
   * Ask first waits for a tap on every move. within_limits acts on its own
   * inside its pot: buys that fit its uninvested money, and sells of what
   * it holds, run without a tap; anything else still asks.
   */
  actMode: z.enum(["ask_first", "within_limits"]),
});
export type SpecialistRulesWire = z.infer<typeof specialistRulesWireSchema>;

/** What lists call a specialist: "Nuclear". */
export const specialistNameSchema = z.string().trim().min(1).max(24);
/** What it is for, in the owner's words: the belief, or the job. */
export const specialistPurposeSchema = z.string().trim().min(1).max(160);
/** Its working notes, and the report it leaves when it retires. */
export const specialistNotesSchema = z.string().trim().min(1).max(4_000);

/** The body `PATCH /specialists/:id` accepts; absent means unchanged. */
export const updateSpecialistRequestSchema = z
  .strictObject({
    purpose: specialistPurposeSchema,
    name: specialistNameSchema,
    actMode: specialistRulesWireSchema.shape.actMode,
    /**
     * Retires one that holds nothing, on its own: 409 `holds_money` while it
     * has anything to sell (that is asked for in its conversation), `in_flight`
     * while a move runs or has only just settled, 503 `unreadable` while a
     * venue can't be read.
     */
    retired: z.literal(true),
  })
  .partial();
export type UpdateSpecialistRequest = z.infer<typeof updateSpecialistRequestSchema>;

export const specialistStatusSchema = z.enum(["active", "retired"]);

/** A take works a belief; a role does an ongoing job. */
export const specialistKindSchema = z.enum(["take", "role"]);

/** A specialist valued live, as GET /specialists and GET /specialists/:id serve it. */
export const specialistWireSchema = z.object({
  id: specialistIdSchema,
  kind: specialistKindSchema,
  name: z.string(),
  /** The person's own words. */
  purpose: z.string(),
  /** Picks the glyph its orb carries; null shows a neutral one. */
  theme: z.string().nullable(),
  rules: specialistRulesWireSchema,
  /** The money the person put behind it. */
  potUsd: dollarsSchema,
  /** Auni's one-line read on how it is going. */
  pulse: z.string().nullable(),
  /** Its own working notes. */
  notes: z.string().nullable(),
  /** What it wrote when it retired. */
  report: z.string().nullable(),
  /** A retired one does nothing more, and keeps its history. */
  status: specialistStatusSchema,
  createdAt: timestampSchema,
  retiredAt: timestampSchema.nullable(),
  valueUsd: dollarsSchema,
  /** Signed: what it has made, net of the money its trades put in or took out. */
  madeUsd: dollarsSchema,
  /** Signed, since the start of the person's day, net the same way. */
  todayChangeUsd: dollarsSchema,
  /** Largest first, as its pane lists them. */
  holdings: z.array(holdingWireSchema),
  /**
   * The chat whose card started it, which its own conversation links back to until it has
   * words of its own; null where none did (one the agent started on its own).
   */
  startedIn: threadIdSchema.nullable(),
});
export type SpecialistWire = z.infer<typeof specialistWireSchema>;
