import {
  sendMessageRequestSchema,
  updateThreadRequestSchema,
  type threadSearchResultWireSchema,
  type threadStateWireSchema,
} from "@auni/shared";
import { desc, eq, ilike, or, sql } from "drizzle-orm";
import express, { Router, type Request, type Response } from "express";
import { z } from "zod";

import { theOwner } from "../auth/owner.ts";
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
import {
  archiveChat,
  deleteChat,
  pinChat,
  renameChat,
  updateThreadAutonomy,
  updateThreadModel,
} from "../conversation/tidy.ts";
import { db } from "../db/client.ts";
import { messages, threads, type ThreadRow } from "../db/schema.ts";
import { cancelLane } from "../jobs/queue.ts";
import { holdingViews } from "../money/holdings.ts";
import { portfolioNow } from "../money/portfolio.ts";
import { heldByTakes, takeChange, takeRecords } from "../money/takes.ts";
import { threadPot } from "../money/pot.ts";
import { centsToUsd } from "../money/usd.ts";
import { startOfDay } from "../money/value-history.ts";

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

/** Live budget headroom and holdings opened in this thread, for the right-hand thread inspector. */
threadsRouter.get("/:threadId/state", async (req, res) => {
  const thread = await threadParam(req, res);
  if (!thread) return;
  const [pot, portfolio, records, { timeZone }] = await Promise.all([
    threadPot(db, thread),
    portfolioNow().catch((error: unknown) => {
      console.warn(`thread ${thread.id} state couldn't read portfolio:`, error);
      return null;
    }),
    takeRecords(),
    theOwner(),
  ]);
  const freeBudgetUsd = centsToUsd(pot.freeCashCents > 0n ? pot.freeCashCents : 0n);
  const mine = portfolio ? (heldByTakes(portfolio, records).threads.get(thread.id) ?? []) : [];
  const holdings = mine.length > 0 ? await holdingViews(mine, startOfDay(timeZone)) : [];
  res.json({
    budgetUsd: thread.budgetUsd,
    freeBudgetUsd,
    holdings,
    ...takeChange(mine),
  } satisfies z.input<typeof threadStateWireSchema>);
});

/** Updates a thread's title, pin, archive, autonomy budget, or model selection. */
threadsRouter.patch("/:threadId", async (req, res) => {
  const body = updateThreadRequestSchema.safeParse(req.body);
  if (!body.success) return invalid(res, body.error);
  const thread = await threadParam(req, res);
  if (!thread) return;
  const { title, archived, pinned, actMode, budgetUsd, modelSelection } = body.data;
  if (title !== undefined) await renameChat(thread, title);
  if (pinned !== undefined) await pinChat(thread, pinned);
  if (actMode !== undefined || budgetUsd !== undefined) {
    await updateThreadAutonomy(thread, {
      ...(actMode !== undefined ? { actMode } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    });
  }
  if (modelSelection !== undefined) await updateThreadModel(thread, modelSelection);
  if (archived !== undefined) {
    const refusal = await archiveChat(thread, archived);
    if (refusal) return void res.status(409).json(refusal);
  }
  void publishThread(thread.id);
  res.json({ thread: await readThreadWire(thread.id) });
});

/** Deletes a thread for good; its moves keep their records (conversation/tidy.ts). */
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
