import { ASK_TOOL_NAMES, isAsk, type messageWireSchema, type threadWireSchema } from "@auni/shared";
import { and, asc, desc, eq, exists, inArray, notInArray, or, sql } from "drizzle-orm";
import type { z } from "zod";

import { db } from "../db/client.ts";
import {
  actions,
  automations,
  messages,
  threads,
  type ActionRow,
  type MessageRow,
  type ThreadRow,
} from "../db/schema.ts";
import { askWaits } from "../asks.ts";
import { cardMoneys, filledFace } from "../money/recipes/index.ts";
import { askLine } from "../money/summaries.ts";
import { replyTargets } from "./history.ts";
import { publishThreadRow } from "./stream.ts";

/** A turn marker older than this is a crashed turn, not a running one. */
const TURN_STALE_MS = 30 * 60_000;

/** Whether a reply is being written in this thread right now. */
export function turnRunning(thread: Pick<ThreadRow, "turnStartedAt">): boolean {
  return (
    thread.turnStartedAt !== null && Date.now() - thread.turnStartedAt.getTime() < TURN_STALE_MS
  );
}

export type ThreadWire = z.input<typeof threadWireSchema>;
type MessageWire = z.input<typeof messageWireSchema>;

/** Money allowed in a thread, by legs: how many went through and how many didn't, of all of them. */
type Moving = NonNullable<ThreadWire["moving"]>;

/** What a thread's row says beyond the thread itself: what waits on the person, what moves, and counts. */
interface RowFacts {
  /** The newest card still waiting on them, in one line. */
  readonly money?: string | null;
  /** Auni's last answer ends on a question nobody has answered. */
  readonly question?: boolean;
  readonly moving?: Moving | null;
  readonly watchCount?: number;
  readonly moveCount?: number;
}

/** A thread with a card still waiting on the person needs them. */
export function threadWire(thread: ThreadRow, facts: RowFacts = {}): ThreadWire {
  const running = turnRunning(thread);
  const money = facts.money ?? null;
  return {
    id: thread.id,
    title: thread.title,
    status: running ? "running" : money ? "needs_user" : "idle",
    actMode: thread.actMode,
    budgetUsd: thread.budgetUsd,
    notes: thread.notes?.trim() ? thread.notes : null,
    modelSelection: thread.modelSelection,
    watchCount: facts.watchCount ?? 0,
    moveCount: facts.moveCount ?? 0,
    pinnedAt: thread.pinnedAt?.toISOString() ?? null,
    archivedAt: thread.archivedAt?.toISOString() ?? null,
    moneyLine: money,
    asking: !running && (facts.question ?? false),
    unread: !running && threadUnread(thread),
    moving: facts.moving ?? null,
    lastActivityAt: thread.updatedAt.toISOString(),
    createdAt: thread.createdAt.toISOString(),
  };
}

/** An answer left since the person last looked. */
export function threadUnread(thread: Pick<ThreadRow, "repliedAt" | "readAt">): boolean {
  if (!thread.repliedAt) return false;
  return !thread.readAt || thread.readAt < thread.repliedAt;
}

/** What a move on a waiting card does, in its card's own short words: its button's. */
function waitingWords(row: ActionRow): string {
  if (isAsk(row.tool)) return askWaits(row);
  return filledFace(row)?.action ?? row.summary;
}

/**
 * Each thread's newest card still waiting on the person, in one line: one to allow, or a held
 * move to check or close (see money/held.ts), said as its tap is with its money. Older cards to
 * allow never linger here: a newer plan replaces them when it is recorded.
 */
async function waitingAsks(threadIds: readonly string[]): Promise<Map<string, string>> {
  if (threadIds.length === 0) return new Map();
  const waiting = await db
    .select()
    .from(actions)
    .where(
      and(
        inArray(actions.threadId, [...threadIds]),
        or(eq(actions.status, "awaiting_permission"), eq(actions.phase, "needs_owner")),
      ),
    )
    .orderBy(desc(actions.createdAt), desc(actions.id));
  const asks = new Map<string, string>();
  for (const action of waiting) {
    if (!action.threadId || asks.has(action.threadId)) continue;
    const held = action.phase === "needs_owner";
    const legs =
      action.proposalId && !held
        ? waiting.filter((leg) => leg.proposalId === action.proposalId).toReversed()
        : [action];
    const moneys = cardMoneys(legs);
    const line = askLine(
      legs.map((leg, index) => ({ says: waitingWords(leg), money: moneys[index]! })),
    );
    if (line) asks.set(action.threadId, held ? `Status unknown: ${line}` : line);
  }
  return asks;
}

/** The parts of a message that say whether it ends on a question, in order. */
type QuestionMark = { readonly type: string; readonly state?: unknown; readonly asks?: boolean };

/**
 * Whether an answer ends on a question still standing: its last suggest_replies asked one,
 * finished, and no card came after it. Options offered with no question are only the next things
 * the person might say, which wait on no one; counted, nearly every chat said "Your turn".
 */
export function endsOnQuestion(marks: readonly QuestionMark[]): boolean {
  const index = marks.findLastIndex(({ type }) => type === "tool-suggest_replies");
  const last = marks[index];
  if (!last?.asks || last.state !== "output-available") return false;
  return !marks.slice(index + 1).some(({ type }) => type === "data-cards");
}

/** The threads whose newest message is Auni asking something; anything the person sends after answers it. */
async function openQuestions(threadIds: readonly string[]): Promise<Set<string>> {
  if (threadIds.length === 0) return new Set();
  // Only the parts that decide it are read, not every answer's whole body.
  const latest = await db
    .selectDistinctOn([messages.threadId], {
      threadId: messages.threadId,
      role: messages.role,
      marks: sql<QuestionMark[]>`(
        select coalesce(jsonb_agg(jsonb_build_object('type', part->>'type', 'state', part->>'state', 'asks', part->'input'->>'question' is not null) order by at), '[]'::jsonb)
        from jsonb_array_elements(${messages.parts}) with ordinality as listed(part, at)
        where part->>'type' in ('tool-suggest_replies', 'data-cards')
      )`,
    })
    .from(messages)
    .where(inArray(messages.threadId, [...threadIds]))
    .orderBy(messages.threadId, desc(messages.createdAt));
  return new Set(
    latest
      .filter(({ role, marks }) => role === "assistant" && endsOnQuestion(marks))
      .map(({ threadId }) => threadId),
  );
}

/**
 * Each thread's money in motion, its cards' legs counted together: every
 * allowed card (a proposal, or a lone action) with a leg still running, and
 * every one that started since the person last read the thread, so how it
 * went stays on the row until they have read Auni's word on it.
 */
async function movingMoney(threadIds: readonly string[]): Promise<Map<string, Moving>> {
  if (threadIds.length === 0) return new Map();
  const cards = await db
    .select({
      threadId: sql<string>`${actions.threadId}`,
      done: sql<number>`(count(*) filter (where ${actions.status} = 'done'))::int`,
      failed: sql<number>`(count(*) filter (where ${actions.status} = 'failed'))::int`,
      total: sql<number>`count(*)::int`,
    })
    .from(actions)
    .innerJoin(threads, eq(threads.id, actions.threadId))
    .where(
      and(
        inArray(actions.threadId, [...threadIds]),
        inArray(actions.status, ["running", "done", "failed"]),
        sql`${actions.phase} is distinct from 'needs_owner'`,
      ),
    )
    .groupBy(actions.threadId, threads.readAt, sql`coalesce(${actions.proposalId}, ${actions.id})`)
    .having(
      sql`bool_or(${actions.status} = 'running') or ${threads.readAt} is null or max(${actions.startedAt}) > ${threads.readAt}`,
    );
  const moving = new Map<string, Moving>();
  for (const { threadId, done, failed, total } of cards) {
    const sum = moving.get(threadId) ?? { done: 0, failed: 0, total: 0 };
    moving.set(threadId, {
      done: sum.done + done,
      failed: sum.failed + failed,
      total: sum.total + total,
    });
  }
  return moving;
}

/** Count of active watches attached to each thread. */
async function activeWatchCounts(threadIds: readonly string[]): Promise<Map<string, number>> {
  if (threadIds.length === 0) return new Map();
  const rows = await db
    .select({
      threadId: automations.threadId,
      count: sql<number>`count(*)::int`,
    })
    .from(automations)
    .where(and(inArray(automations.threadId, [...threadIds]), eq(automations.status, "active")))
    .groupBy(automations.threadId);
  return new Map(rows.map((row) => [row.threadId, row.count]));
}

/** Count of settled or running money cards in each thread (so the inspector knows when there is activity). */
async function moneyMoveCounts(threadIds: readonly string[]): Promise<Map<string, number>> {
  if (threadIds.length === 0) return new Map();
  const rows = await db
    .select({
      threadId: sql<string>`${actions.threadId}`,
      count: sql<number>`count(distinct coalesce(${actions.proposalId}, ${actions.id}))::int`,
    })
    .from(actions)
    .where(
      and(
        inArray(actions.threadId, [...threadIds]),
        inArray(actions.status, ["running", "done"]),
        notInArray(actions.tool, [...ASK_TOOL_NAMES]),
      ),
    )
    .groupBy(actions.threadId);
  return new Map(rows.map((row) => [row.threadId, row.count]));
}

async function rowFacts(threadIds: readonly string[]) {
  const [money, questions, moving, watches, moves] = await Promise.all([
    waitingAsks(threadIds),
    openQuestions(threadIds),
    movingMoney(threadIds),
    activeWatchCounts(threadIds),
    moneyMoveCounts(threadIds),
  ]);
  return (id: string): RowFacts => ({
    money: money.get(id) ?? null,
    question: questions.has(id),
    moving: moving.get(id) ?? null,
    watchCount: watches.get(id) ?? 0,
    moveCount: moves.get(id) ?? 0,
  });
}

/**
 * Every conversation, archived ones too: the web lists the rest, and opens an archived one search
 * finds. Threads with no messages yet (the main conversation, made just before Auni speaks in it)
 * stay hidden.
 */
export async function listThreads(): Promise<ThreadWire[]> {
  const rows = await db
    .select()
    .from(threads)
    .where(
      exists(
        db
          .select({ one: sql`1` })
          .from(messages)
          .where(eq(messages.threadId, threads.id)),
      ),
    )
    .orderBy(desc(threads.updatedAt));
  const facts = await rowFacts(rows.map((thread) => thread.id));
  return rows.map((thread) => threadWire(thread, facts(thread.id)));
}

export async function readThreadWire(threadId: string): Promise<ThreadWire | undefined> {
  const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
  if (!thread) return undefined;
  const facts = await rowFacts([threadId]);
  return threadWire(thread, facts(threadId));
}

/**
 * Tells the owner's open tabs a thread's row changed (a turn began or ended,
 * an action was allowed, a title arrived, autonomy or model changed). Best effort.
 */
export async function publishThread(threadId: string): Promise<void> {
  try {
    const thread = await readThreadWire(threadId);
    if (thread) publishThreadRow(thread);
  } catch (error) {
    console.error("live thread publish failed", error);
  }
}

export async function threadById(threadId: string): Promise<ThreadRow | undefined> {
  const [row] = await db.select().from(threads).where(eq(threads.id, threadId));
  return row;
}

export async function threadMessages(threadId: string): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt));
}

export function messagesWire(rows: readonly MessageRow[]): MessageWire[] {
  const targets = replyTargets(rows);
  return rows.map((row) => {
    const replyToId = targets.get(row.id);
    return {
      id: row.id,
      role: row.role,
      // Stored as the UI message parts the turn streamed.
      parts: row.parts as MessageWire["parts"],
      metadata: {
        ...row.metadata,
        createdAt: row.createdAt.toISOString(),
        origin: row.origin,
        ...(row.supersedesId ? { supersedesId: row.supersedesId } : {}),
        ...(row.role === "assistant" && replyToId ? { replyToId } : {}),
      },
    };
  });
}
