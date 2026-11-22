import { and, count, eq, gte, sql } from "drizzle-orm";

import { db, type Tx } from "../db/client.ts";
import { actions, threads, type TurnRecord } from "../db/schema.ts";
import { answered } from "./tidy.ts";

// What a turn leaves on its thread as it goes (`threads.answer_so_far`, a TurnRecord), so that a
// turn whose run was cut off, by Auni dying or by the write that would have ended its job
// failing, is judged from what is durably written and nothing else: whose record it is, what it
// had shown, whether it had called a tool, and whether it ended. A thread runs one turn at a
// time, so one record a thread is enough: the next turn begins by writing over it.

type Part = { readonly type: string };

/** This turn's own record, while it hasn't ended: the only one a running turn writes to. */
const ownOpenRecord = (threadId: string, turn: string) =>
  and(
    eq(threads.id, threadId),
    sql`${threads.answerSoFar}->>'turn' = ${turn}`,
    sql`${threads.answerSoFar}->'ended' is null`,
  );

/**
 * The running turn of each thread, so the tools' door can have a tool call recorded first, and a
 * tool can know what the owner has been shown so far.
 */
const running = new Map<
  string,
  { beforeTool(): Promise<void>; readonly heard: readonly unknown[] }
>();

/**
 * Records that the thread's running turn calls one of Auni's tools, before the tool runs. A
 * tool can change things no card or move shows (a watch, a routine, a setting), so this is how a
 * turn cut off right after one is known to have acted. A call with no turn running here has
 * nothing to record: its token is refused before it reaches a tool.
 */
export async function beforeTool(threadId: string): Promise<void> {
  await running.get(threadId)?.beforeTool();
}

/**
 * Calls that do nothing toward the answer, so words written before them are still the reply: the
 * question itself, and naming the chat, which a turn may do once its reply is written.
 */
const AFTER_THE_REPLY = new Set(["tool-suggest_replies", "tool-name_chat"]);

/**
 * Whether the thread's running turn has written words since its last step: the reply that a
 * question asked now would show under. Its thinking is not among them, as the owner never sees it.
 */
export function wroteSinceLastStep(threadId: string): boolean {
  const parts = (running.get(threadId)?.heard ?? []) as { type: string; text?: string }[];
  const lastStep = parts.findLastIndex(
    ({ type }) => type.startsWith("tool-") && !AFTER_THE_REPLY.has(type),
  );
  return parts.slice(lastStep + 1).some(({ type, text }) => type === "text" && text?.trim());
}

/** How often words alone are saved as a turn goes; a step or a card is saved as it shows. */
const SAVE_WORDS_MS = 2_000;

/**
 * Keeps a running turn's record as it goes, so a turn cut off when Auni dies still has what it
 * showed (keepCutTurn). One write at a time, the latest winning, and only to the turn's own
 * record while it hasn't ended, so nothing is written after the turn ends.
 */
export function recordedAsItGoes(threadId: string, turn: Pick<TurnRecord, "turn" | "began">) {
  /** The answer as last heard, and what is still to be written of it. */
  let heard: readonly unknown[] = [];
  let latest: readonly unknown[] | null = null;
  let usedTool = false;
  let steps = 0;
  let timer: NodeJS.Timeout | undefined;
  let saving: Promise<void> | undefined;
  const write = async () => {
    for (let parts = latest; parts; parts = latest) {
      latest = null;
      const record: TurnRecord = { ...turn, parts, ...(usedTool ? { usedTool: true } : {}) };
      await db
        .update(threads)
        .set({ answerSoFar: record })
        .where(ownOpenRecord(threadId, turn.turn))
        .catch((error: unknown) => console.error("an answer so far wasn't saved", error));
    }
    saving = undefined;
  };
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    saving ??= write();
  };
  const recorder = {
    /** Whether it called one of Auni's tools. */
    get usedTool() {
      return usedTool;
    },
    /** The answer as last heard. */
    get heard() {
      return heard;
    },
    save(parts: readonly Part[]) {
      heard = latest = parts;
      const shown = parts.filter(({ type }) => type !== "text").length;
      if (shown !== steps) {
        steps = shown;
        flush();
      } else timer ??= setTimeout(flush, SAVE_WORDS_MS);
    },
    /** Saves the answer with `part` added, before the owner sees it. */
    async before(part: unknown) {
      latest = [...heard, part];
      flush();
      await saving;
    },
    async beforeTool() {
      if (!usedTool) {
        usedTool = true;
        latest ??= heard;
        flush();
      }
      await saving;
    },
    /** Stops saving, once the last write has landed. */
    async end() {
      if (running.get(threadId) === recorder) running.delete(threadId);
      clearTimeout(timer);
      latest = null;
      await saving;
    },
  };
  running.set(threadId, recorder);
  return recorder;
}

/**
 * Whether a turn did nothing the owner or the books can see: it called none of Auni's tools
 * (its record says so before a tool runs, and so does a step or a card among what it showed),
 * and no move was recorded in its thread since it began. Words it had begun to say, which no
 * answer kept, are dropped with it. This is the one judgement of whether a background turn
 * that failed or was cut off may run again; an answer it kept ends it (`ended`), which is asked
 * before this.
 */
export async function didNothing(
  threadId: string,
  began: Date,
  seen: { readonly parts: readonly unknown[]; readonly usedTool?: boolean },
): Promise<boolean> {
  if (seen.usedTool) return false;
  const acted = ({ type }: Part) => type.startsWith("tool-") || type.startsWith("data-");
  if ((seen.parts as Part[]).some(acted)) return false;
  const [recorded] = await db
    .select({ moves: count() })
    .from(actions)
    .where(and(eq(actions.threadId, threadId), gte(actions.createdAt, began)));
  return (recorded?.moves ?? 0) === 0;
}

/**
 * Ends the turn on its thread's record, in the write that keeps its answer when it leaves one:
 * from then on it is never run again, nor said to be cut off. `replied` marks the thread unread
 * for an answer left behind, and brings it back if it was archived.
 */
export async function endRecord(
  tx: Pick<Tx, "update">,
  threadId: string,
  turn: Pick<TurnRecord, "turn" | "began">,
  { replied = false }: { readonly replied?: boolean } = {},
): Promise<void> {
  const record: TurnRecord = { ...turn, parts: [], ended: true };
  await tx
    .update(threads)
    .set({ answerSoFar: record, ...(replied ? answered() : {}) })
    .where(eq(threads.id, threadId));
}

/**
 * What a turn had left on record when its run was cut off: that it ended, what it had shown and
 * done if it began, or null when it never began (the record is another turn's, or none).
 */
export async function recordOf(threadId: string, turn: string): Promise<TurnRecord | null> {
  const [thread] = await db
    .select({ record: threads.answerSoFar })
    .from(threads)
    .where(eq(threads.id, threadId));
  return thread?.record?.turn === turn ? thread.record : null;
}
