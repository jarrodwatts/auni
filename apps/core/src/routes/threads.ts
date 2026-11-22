import { sendMessageRequestSchema, type threadSearchResultWireSchema } from "@auni/shared";
import { desc, eq, ilike, or, sql } from "drizzle-orm";
import express, { Router, type Request, type Response } from "express";
import { z } from "zod";

import { stopTurn } from "../conversation/stop.ts";
import { publishThreadGone } from "../conversation/stream.ts";
import {
  listThreads,
  messagesWire,
  publishThread,
  threadById,
  readThreadWire,
  threadMessages,
  threadUnread,
  threadWire,
  turnRunning,
} from "../conversation/threads.ts";
import { messageText } from "../conversation/history.ts";
import { sendMessage } from "../conversation/send.ts";
import { archiveChat, deleteChat, renameChat } from "../conversation/tidy.ts";
import { db } from "../db/client.ts";
import { messages, threads, type ThreadRow } from "../db/schema.ts";
import { cancelLane } from "../jobs/queue.ts";

const MAX_TITLE_CHARS = 160;

export const threadsRouter = Router();
threadsRouter.use(express.json({ limit: "64kb" }));

const idSchema = z.uuid();

function invalid(res: Response, error: z.ZodError): void {
  res.status(400).json({ error: "invalid_body", issues: error.issues });
}

/** Resolves :threadId to a thread the caller owns, or answers 404. */
async function threadParam(req: Request, res: Response): Promise<ThreadRow | undefined> {
  const id = idSchema.safeParse(req.params.threadId);
  const thread = id.success ? await threadById(id.data) : undefined;
  if (!thread) res.status(404).json({ error: "thread_not_found" });
  return thread;
}

threadsRouter.get("/", async (_req, res) => {
  res.json({ threads: await listThreads() });
});

threadsRouter.get("/search", async (req, res) => {
  const query = z.string().trim().min(1).max(200).safeParse(req.query.q);
  if (!query.success) return void res.json({ results: [] });
  const pattern = `%${query.data.replace(/[\\%_]/gu, "\\$&")}%`;
  const rows = await db
    .selectDistinctOn([threads.id], { thread: threads, message: messages })
    .from(threads)
    .innerJoin(messages, eq(messages.threadId, threads.id))
    // Archived chats too: search is how one is found again.
    .where(or(ilike(threads.title, pattern), sql`${messages.parts}::text ilike ${pattern}`))
    .orderBy(threads.id, desc(messages.createdAt))
    .limit(20);
  const needle = query.data.toLocaleLowerCase();
  const results = rows.map(({ thread, message }): z.input<typeof threadSearchResultWireSchema> => {
    const text = messageText(message.parts);
    const at = text.toLocaleLowerCase().indexOf(needle);
    const titleMatch = (thread.title ?? "").toLocaleLowerCase().includes(needle) || at < 0;
    return {
      thread: threadWire(thread),
      source: titleMatch ? ("title" as const) : ("message" as const),
      snippet: titleMatch ? null : text.slice(Math.max(0, at - 60), at + 220),
      messageRole: titleMatch ? null : message.role,
      messageCreatedAt: titleMatch ? null : message.createdAt.toISOString(),
    };
  });
  res.json({ results });
});

/**
 * The thread's messages, and whether a turn is queued or running. The thread is read first, so
 * a turn it calls over has its answer among the messages.
 */
threadsRouter.get("/:threadId/messages", async (req, res) => {
  const thread = await threadParam(req, res);
  if (!thread) return;
  res.json({
    messages: messagesWire(await threadMessages(thread.id)),
    running: turnRunning(thread),
  });
});

const updateSchema = z
  .object({ title: z.string().trim().min(1).max(MAX_TITLE_CHARS), archived: z.boolean() })
  .partial();

/** Renames a chat, or archives it or brings it back; a refusal says why in the owner's words. */
threadsRouter.patch("/:threadId", async (req, res) => {
  const body = updateSchema.safeParse(req.body);
  if (!body.success) return invalid(res, body.error);
  const thread = await threadParam(req, res);
  if (!thread) return;
  const { title, archived } = body.data;
  const refusal =
    (title !== undefined ? await renameChat(thread, title) : undefined) ??
    (archived !== undefined ? await archiveChat(thread, archived) : undefined);
  if (refusal) return void res.status(409).json(refusal);
  void publishThread(thread.id);
  res.json({ thread: await readThreadWire(thread.id) });
});

/** Deletes a chat for good; its moves keep their records (conversation/tidy.ts). */
threadsRouter.delete("/:threadId", async (req, res) => {
  const thread = await threadParam(req, res);
  if (!thread) return;
  const refusal = await deleteChat(thread);
  if (refusal) return void res.status(409).json(refusal);
  publishThreadGone(thread.id);
  res.status(204).end();
});

/** The person has seen everything in the thread so far, on whichever device. */
threadsRouter.post("/:threadId/read", async (req, res) => {
  const thread = await threadParam(req, res);
  if (!thread) return;
  if (thread.repliedAt && threadUnread(thread)) {
    // Read up to the answer this request saw, so one landing meanwhile stays unread.
    const seen = thread.repliedAt.toISOString();
    await db
      .update(threads)
      .set({ readAt: sql`greatest(${threads.readAt}, ${seen}::timestamptz)` })
      .where(eq(threads.id, thread.id));
    void publishThread(thread.id);
  }
  res.status(204).end();
});

threadsRouter.post("/:threadId/messages", async (req, res) => {
  const body = sendMessageRequestSchema.safeParse(req.body);
  if (!body.success) return invalid(res, body.error);
  const thread = await threadParam(req, res);
  if (!thread) return;
  const { id, text, supersedesId } = body.data;
  const sent = await sendMessage(thread, { id, text, ...(supersedesId ? { supersedesId } : {}) });
  if (sent === "not_theirs")
    return void res.status(400).json({ error: "superseded_message_not_found" });
  // Kept out for the private key it held: no turn answers it, and Auni's answer is posted.
  if (sent === "key_kept_out") return void res.status(200).json({ keyKeptOut: true });
  res.status(202).json({ turnId: id });
});

threadsRouter.post("/:threadId/stop", async (req, res) => {
  const thread = await threadParam(req, res);
  if (!thread) return;
  stopTurn(thread.id);
  await cancelLane(db, `thread:${thread.id}`);
  await db.update(threads).set({ turnStartedAt: null }).where(eq(threads.id, thread.id));
  void publishThread(thread.id);
  res.status(204).end();
});
