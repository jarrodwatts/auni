import { z } from "zod";

import {
  automationFireIdSchema,
  automationRuleIdSchema,
  specialistIdSchema,
  messageIdSchema,
  threadIdSchema,
  timestampSchema,
} from "./shared.ts";

const messageRoleSchema = z.enum(["user", "assistant"]);

/** A conversation as core serves it: the sidebar row, and the thread a route lands in. */
export const threadWireSchema = z.object({
  id: threadIdSchema,
  /** The specialist this conversation belongs to; null for a chat. */
  specialistId: specialistIdSchema.nullable(),
  /** Null until one is written. */
  title: z.string().nullable(),
  /** Running while a turn is; needs_user while a card waits on the person. */
  status: z.enum(["running", "needs_user", "idle"]),
  /** When the owner archived it out of History; null while it is listed. */
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
  | { readonly kind: "turn-end"; readonly turnId: string; readonly failed?: true }
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
