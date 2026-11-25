import { z } from "zod";

import { dollarsSchema } from "./money.ts";
import { holdingWireSchema } from "./portfolio.ts";
import { modelSelectionSchema } from "./setup.ts";
import {
  automationFireIdSchema,
  automationRuleIdSchema,
  messageIdSchema,
  threadIdSchema,
  timestampSchema,
} from "./shared.ts";

const messageRoleSchema = z.enum(["user", "assistant"]);

/**
 * How Auni gets the owner's go-ahead in a thread. `ask_first` waits for a tap on every move.
 * `within_limits` lets buys within the thread's uninvested budget, and sells of holdings this
 * thread bought, run straight away; leveraged perps, bridges and withdrawals still ask.
 */
export const threadActModeSchema = z.enum(["ask_first", "within_limits"]);
export type ThreadActMode = z.infer<typeof threadActModeSchema>;

/** Working notes kept by Auni for an ongoing thread. */
export const threadNotesSchema = z.string().trim().min(1).max(4_000);

/** A conversation as core serves it: the sidebar row, and the thread a route lands in. */
export const threadWireSchema = z.object({
  id: threadIdSchema,
  /** Null until one is written. */
  title: z.string().nullable(),
  /** Running while a turn is; needs_user while a card waits on the person. */
  status: z.enum(["running", "needs_user", "idle"]),
  /** How Auni acts on moves in this thread. */
  actMode: threadActModeSchema.default("ask_first"),
  /** Dollar spending ceiling when `actMode` is `within_limits`. */
  budgetUsd: dollarsSchema.default("0.00"),
  /** Working notes Auni keeps for this thread; null when none. */
  notes: z.string().nullable().default(null),
  /** Explicit brain, model and effort chosen for this thread; null uses owner/auto default. */
  modelSelection: modelSelectionSchema.nullable().default(null),
  /** Number of active watches or schedules attached to this thread. */
  watchCount: z.number().int().min(0).default(0),
  /** Number of settled money moves in this thread, so the inspector knows when there is history. */
  moveCount: z.number().int().min(0).default(0),
  /** When the owner pinned this thread to the top of the sidebar; null otherwise. */
  pinnedAt: timestampSchema.nullable().default(null),
  /** When the owner archived it out of the sidebar; null while it is listed. */
  archivedAt: timestampSchema.nullable(),
  /** What the thread waits on the person for, in one line: "Sell $80 of Lilly". */
  moneyLine: z.string().nullable(),
  /** Auni's last answer asks the person something they haven't answered. */
  asking: z.boolean().default(false),
  /** Auni answered since the person last read the thread. */
  unread: z.boolean().default(false),
  /**
   * The money the person allowed here, by legs: how many went through and how many
   * didn't, of all of them. Set while any leg runs, and once they have all settled
   * until the person reads the thread; null otherwise.
   */
  moving: z
    .object({
      done: z.number().int().min(0),
      failed: z.number().int().min(0),
      total: z.number().int().min(1),
    })
    .nullable()
    .default(null),
  lastActivityAt: timestampSchema,
  createdAt: timestampSchema,
});
export type ThreadWire = z.infer<typeof threadWireSchema>;

/** `PATCH /threads/:threadId`: every field is optional; absent means unchanged. */
export const updateThreadRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    archived: z.boolean(),
    pinned: z.boolean(),
    actMode: threadActModeSchema,
    budgetUsd: dollarsSchema,
    modelSelection: modelSelectionSchema.nullable(),
  })
  .partial();
export type UpdateThreadRequest = z.infer<typeof updateThreadRequestSchema>;

/** `GET /threads/:threadId/state`: live budget headroom and holdings opened in this thread. */
export const threadStateWireSchema = z.object({
  budgetUsd: dollarsSchema,
  freeBudgetUsd: dollarsSchema,
  holdings: z.array(holdingWireSchema),
});
export type ThreadStateWire = z.infer<typeof threadStateWireSchema>;

/** `GET /threads/search`: a title match carries no message; a message match says which. */
export const threadSearchResultWireSchema = z.object({
  thread: threadWireSchema,
  source: z.enum(["title", "message"]),
  snippet: z.string().nullable(),
  messageRole: messageRoleSchema.nullable(),
  messageCreatedAt: timestampSchema.nullable(),
});

/** What a message says about itself, stored or at the start of its stream. */
export const messageMetadataWireSchema = z.looseObject({
  createdAt: timestampSchema.optional(),
  /** An answer core started on its own (an automation, a finished action) is not "human". */
  origin: z.enum(["human", "automation"]).optional(),
  /** The owner's message this one replaces after a regenerate or an edit-and-resend. */
  supersedesId: messageIdSchema.optional(),
  /** The owner's message an answer belongs to. */
  replyToId: messageIdSchema.optional(),
  /** The person stopped this answer before Auni finished it. */
  stopped: z.literal(true).optional(),
  /** No AI could think on this computer, so this answer only says so; one signed in answers again. */
  noBrain: z.literal(true).optional(),
  /** Core left it outside any turn, such as money arriving: no AI worked on it. */
  posted: z.literal(true).optional(),
  workDurationMs: z.number().int().min(0).optional(),
  /** The watches whose firing started this answer, each named as the person saw it set up. */
  fires: z
    .array(
      z.object({
        automationId: automationRuleIdSchema,
        fireId: automationFireIdSchema,
        watch: z.string(),
      }),
    )
    .optional(),
  /** A background answer that ended with nothing worth telling, and why. */
  quiet: z.string().optional(),
});

/** `GET /threads/:id/messages`: each message in the UI parts it streamed as. */
export const messageWireSchema = z.object({
  id: messageIdSchema,
  role: messageRoleSchema,
  parts: z.array(z.looseObject({ type: z.string() })),
  metadata: messageMetadataWireSchema,
});

/**
 * How far a turn has got before its first words: Auni has the message and is starting
 * the brain in its workspace, then the brain is up and thinking.
 */
export type TurnProgressStage = "workspace" | "thinking";

/** A thread's turns as the browser hears them. */
export type ThreadStreamEvent<Chunk> =
  | { readonly kind: "progress"; readonly turnId: string; readonly stage: TurnProgressStage }
  | { readonly kind: "chunks"; readonly turnId: string; readonly chunks: readonly Chunk[] }
  /** Sent after the answer is persisted, so a refetch from here on sees it. */
  | {
      readonly kind: "turn-end";
      readonly turnId: string;
      readonly failed?: true;
      readonly stopped?: true;
    }
  /**
   * A message core left outside any turn, such as money arriving, persisted: a
   * refetch sees it. A turn may be running meanwhile, and is no business of it.
   */
  | { readonly kind: "posted"; readonly messageId: string };

/**
 * One message on `GET /live`, the one stream a tab keeps open: a sidebar row changed (`Row` is
 * the row as sent, or as received before it is parsed) or was deleted, a thread's turn moved
 * on, a setting was saved (a key, an app turned on or off), so what `GET /apps` says has
 * changed, or what Auni is doing to make a brain ready moved on, so `GET /brains` has.
 */
export type LiveMessage<Chunk, Row = ThreadWire> =
  | { readonly topic: "row"; readonly thread: Row }
  | { readonly topic: "gone"; readonly threadId: string }
  | { readonly topic: "apps" }
  | { readonly topic: "brains" }
  | { readonly topic: "me" }
  | { readonly topic: "starting-points" }
  | {
      readonly topic: "thread";
      readonly threadId: string;
      readonly event: ThreadStreamEvent<Chunk>;
    };
