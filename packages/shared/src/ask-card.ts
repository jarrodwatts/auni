import { z } from "zod";

import { actionStatusSchema } from "./action.ts";
import { cardBaseSchema } from "./card-base.ts";
import { actionRecordIdSchema } from "./shared.ts";
import { ASK_TOOL_NAMES, type AskToolName } from "./tools.ts";

/**
 * Auni asking to change Auni itself rather than move money: widen how a thread acts (auto budget),
 * save a routine, turn an app back on, or take a secret. Like a money card it is an action row
 * the owner allows or declines (POST /actions/:id/allow), so one path decides every card on every
 * channel; a secret's card is allowed by the secret saved in its field.
 */
export const askCardSchema = cardBaseSchema.extend({
  kind: z.literal("ask"),
  actionReference: actionRecordIdSchema,
  ask: z.enum(ASK_TOOL_NAMES),
  /** "Let this take trade on its own up to $500"; as recorded, so see askSummary. */
  summary: z.string().max(500),
  /** Everything the Allow agrees to, a routine's whole text included. */
  lines: z.array(z.object({ label: z.string().max(60), value: z.string().max(4_000) })).max(8),
  /** The main button, named for what the tap does and how much: "Allow $500 budget". */
  action: z.string().max(60),
  status: actionStatusSchema,
  /** The app a connect_app card offers, or whose secret a request_secret card asks for, by id. */
  app: z.string().optional(),
  /** The private field a request_secret card asks for, by id; absent on every other ask. */
  field: z.string().optional(),
});
export type AskCardWire = z.infer<typeof askCardSchema>;

/**
 * The lines of an ask that a card may draw apart from the rest, by their labels. Core writes a
 * line under each of these words; a drawing finds it by the same word.
 */
export const ASK_LINE = {
  budget: "Budget",
  acts: "How it acts",
  /**
   * A connect or secret card's: Auni's own sentence on what the app or the secret would add, and
   * what the tap changes.
   */
  why: "Auni says",
  changes: "What it changes",
} as const;

/**
 * An ask's summary in today's words, on every surface: an Auto card recorded while a take was
 * still called a thread ("Let this thread trade on its own up to $500") reads "Let this take
 * trade…". Only the words it is shown in change; what the tap allows is the row's own input
 * and lines.
 */
export function askSummary(summary: string): string {
  return summary.replace(/^Let this thread /u, "Let this take ");
}

/** What an allowed ask says once it applied, on every surface. */
export const ASK_DONE: Readonly<Record<AskToolName, string>> = {
  set_thread_autonomy: "Updated",
  save_routine: "Saved",
  connect_app: "Turned on",
  request_secret: "Saved",
};
