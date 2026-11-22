import { randomUUID } from "node:crypto";

import type { TurnProgressStage } from "@auni/shared";

import type { UIMessage } from "ai";
import { and, eq, gt, gte, isNull, notInArray, or, sql } from "drizzle-orm";

import {
  brainBox,
  limitNotice,
  refusedNotice,
  nothingToThinkWith,
  pickBrain,
  restingUntil,
  runTurn,
  type TurnResult,
} from "../agent/brain.ts";
import { chooseRole, systemPrompt, turnContext } from "../agent/prompt.ts";
import { theOwner } from "../auth/owner.ts";
import { signTurnToken } from "../auth/turn-token.ts";
import { openingLine, settleFires } from "../automations/automations.ts";
import { markBriefed } from "../automations/brief.ts";
import { homeChannel } from "../channels/home.ts";
import { declinedOffers } from "../connect.ts";
import { db, type Tx } from "../db/client.ts";
import {
  actions,
  specialists,
  messages,
  threads,
  type MessageRow,
  type TurnRecord,
} from "../db/schema.ts";
import { env } from "../env.ts";
import { deliverKind } from "../jobs/kinds.ts";
import { auniContext, specialistContext, waitingCardsContext } from "../specialists/context.ts";
import { step } from "../money/life.ts";
import { arrivalsPromptContext, landLate } from "../money/news.ts";
import { walletAddresses } from "../money/wallets.ts";
import {
  messageText,
  promptBlocks,
  renderTurnPrompt,
  visibleMessages,
  type TurnTrigger,
} from "./history.ts";
import { trackTurn } from "./stop.ts";
import { publishThreadEvent } from "./stream.ts";
import { publishThread, threadMessages } from "./threads.ts";
import { didNothing, endRecord, recordOf, recordedAsItGoes } from "./turn-record.ts";

// A thread's marker (`threads.turn_started_at`) says a turn is coming or running, and names the
// running one: its turn token holds it, and works only while the marker is unmoved.
//
//   owner's message  --> set, if unset (a turn is coming)        a running turn keeps its own
//   a turn begins    --> set afresh: this turn's alone
//   a turn ends      --> moved on, if an owner's message waits; else cleared
//
// So a new message never takes a running turn's tools away, and an ended turn's token never
// works again, even while the next one waits.

/**
 * Marks the turn as running and begins its record, in one write; returns the database's clock at
 * that moment and the stored marker.
 */
async function markTurnBegan(
  threadId: string,
  turnId: string,
): Promise<{ began: Date; marker: Date }> {
  // Rounded as the millisecond column rounds, so the record's start and the marker are one time.
  const began = sql<string>`now()::timestamptz(3)`;
  const [row] = await db
    .update(threads)
    .set({
      turnStartedAt: began,
      answerSoFar: sql`jsonb_build_object('turn', ${turnId}::text, 'began', ${began}, 'parts', '[]'::jsonb)`,
    })
    .where(eq(threads.id, threadId))
    .returning({ began, marker: threads.turnStartedAt });
  if (!row?.marker) throw new Error(`Thread ${threadId} not found.`);
  return { began: new Date(row.began), marker: row.marker };
}

/**
 * Clears the running marker, or moves it on while an owner's message sent after this turn began,
 * but the one it answers, waits for its own: the thread still shows a turn coming, and this
 * one's token is spent.
 */
async function markTurnEnded(
  threadId: string,
  turn: Pick<TurnRecord, "turn" | "began">,
  executor: Pick<Tx, "update"> = db,
): Promise<void> {
  const waiting = and(
    eq(messages.threadId, threads.id),
    eq(messages.role, "user"),
    gt(messages.createdAt, new Date(turn.began)),
    // A background turn's id is its job's, never a message's.
    sql`${messages.id}::text <> ${turn.turn}`,
  );
  await executor
    .update(threads)
    .set({
      turnStartedAt: sql`case when ${threads.turnStartedAt} is not null and exists (select 1 from ${messages} where ${waiting}) then now() end`,
      updatedAt: sql`now()`,
    })
    .where(eq(threads.id, threadId));
}

/**
 * Ends a turn for good, in one write: its record says it ended, so it is never run again nor
 * said to be cut off, and its marker is cleared. `keeps` writes the answer it leaves, if any,
 * in the same write; `replied` marks the thread unread for it.
 */
async function endTurn(
  threadId: string,
  turn: Pick<TurnRecord, "turn" | "began">,
  { keeps, replied }: { readonly keeps?: (tx: Tx) => Promise<void>; readonly replied?: boolean },
): Promise<void> {
  await db.transaction(async (tx) => {
    await keeps?.(tx);
    await endRecord(tx, threadId, turn, { replied: replied === true });
    await markTurnEnded(threadId, turn, tx);
  });
}

const CUT_OFF = "I was cut off partway through this.";
const ASK_AGAIN = "Try again";

/**
 * What Auni says under an answer it was cut off in, by Auni stopping (a crash, a shutdown, the
 * computer sleeping), and only what is true of what the turn left: nothing, when it had done
 * nothing; that its cards still stand, when it showed any; and that a move it had already
 * started, which no card above shows, carries on.
 */
async function cutOffWords(
  threadId: string,
  began: Date,
  seen: { readonly parts: readonly unknown[]; readonly usedTool?: boolean },
): Promise<string> {
  if (await didNothing(threadId, began, seen)) return `${CUT_OFF} Nothing was sent or changed.`;
  const shown = [...cardsShown(seen.parts)];
  const [unshown] = await db
    .select({ id: actions.id })
    .from(actions)
    .where(
      and(
        eq(actions.threadId, threadId),
        gte(actions.createdAt, began),
        eq(actions.status, "running"),
        ...(shown.length > 0
          ? [
              notInArray(actions.id, shown),
              or(isNull(actions.proposalId), notInArray(actions.proposalId, shown)),
            ]
          : []),
      ),
    )
    .limit(1);
  return [
    CUT_OFF,
    ...(shown.length > 0
      ? ["What I had proposed is on the cards above, and a move you allowed carries on."]
      : []),
    ...(unshown ? ["A move I had already started carries on."] : []),
  ].join(" ");
}

/**
 * An answer that ended short, cut off or stopped by the owner, with one reply that asks again,
 * offered as suggest_replies offers the next thing to say: docked as one button on the web, a
 * button on a channel, and the agent reads it in its history like any it offered.
 */
function askingAgain<Part>(parts: readonly Part[]): Part[] {
  return [
    ...parts,
    {
      type: "tool-suggest_replies",
      toolCallId: `again-${randomUUID()}`,
      state: "output-available",
      input: { options: [{ label: ASK_AGAIN }] },
      output: `Offered: ${ASK_AGAIN}`,
    } as Part,
  ];
}

/** An answer cut off: what it had shown, the words that say so, and one reply that asks again. */
function cutOff<Part>(parts: readonly Part[], words: string): Part[] {
  return askingAgain([...parts, { type: "text", text: words, state: "done" } as Part]);
}

/**
 * What the owner needs to hear that the brain can't say: that none can think yet, and the command
 * that fixes each, that its login was refused, or that their plan ran out.
 */
async function turnNotice(
  result: TurnResult,
  picked: Awaited<ReturnType<typeof pickBrain>>,
  timeZone: string,
): Promise<string | null> {
  if ("fixes" in picked) return nothingToThinkWith(picked.fixes);
  if (result.refused) return refusedNotice(picked.about, result.refused);
  return result.limit ? limitNotice(picked, result.limit.resetsAt, timeZone) : null;
}

/** Why a background turn ended with nothing to tell, when it called settle_quietly. */
function settledQuietly(parts: readonly unknown[]): string | undefined {
  const call = (parts as { type: string; state?: string; input?: { reason?: unknown } }[]).find(
    (part) => part.type === "tool-settle_quietly" && part.state === "output-available",
  );
  if (!call) return undefined;
  const reason = typeof call.input?.reason === "string" ? call.input.reason.trim() : "";
  return reason || "nothing worth telling";
}

/**
 * The channel a turn's answer goes to besides the web app: back to the one the owner's message
 * came from, even a failure with nothing to show; or, said unasked, their home channel when it has
 * something to tell (channels/home.ts). Null for the web app alone.
 */
async function answersOn(input: {
  readonly trigger: TurnTrigger;
  readonly visible: readonly Pick<MessageRow, "id" | "metadata">[];
  /** A background answer kept that didn't settle quietly. */
  readonly tells: boolean;
}): Promise<string | null> {
  const { trigger } = input;
  if (trigger.kind === "message")
    return input.visible.find(({ id }) => id === trigger.messageId)?.metadata.channel ?? null;
  return input.tells ? homeChannel() : null;
}

function withNotice(message: UIMessage, notice: string): UIMessage {
  return { ...message, parts: [...message.parts, { type: "text", text: notice, state: "done" }] };
}

/** How long a background turn that fails before doing anything keeps being tried again. */
const RETRY_FOR_MS = 24 * 60 * 60_000;
const RETRY_MS = 5 * 60_000;
const SOONEST_RETRY_MS = 60_000;

/** What the owner reads when a background turn kept failing for a day. */
const GAVE_UP =
  "Something happened that Auni meant to tell you about, but it couldn't think for a day. " +
  "Ask about it here and Auni will pick it up.";

/**
 * When to try a failed background turn again: after a usage limit, once a brain can think (now,
 * when another is ready); after an error, in a few minutes.
 */
async function retryIn(result: TurnResult): Promise<number> {
  if (!result.limit) return RETRY_MS;
  const next = await pickBrain();
  const until = "about" in next ? restingUntil(next.about.id) : null;
  return Math.max(SOONEST_RETRY_MS, (until?.getTime() ?? 0) - Date.now());
}

/** A background turn to run again, as the same job, in this many milliseconds. */
type TurnAgain = { readonly again: number } | undefined;

/** Loads the thread, renders history, runs the turn on the brain while streaming it, and persists the answer. */
export async function runConversationTurn(input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly trigger: TurnTrigger;
  /** Ends the turn as if the person stopped it: the machine slept, or Auni is stopping. */
  readonly ended?: AbortSignal;
  /** When what woke it was first queued; a failed background turn is tried for a day from it. */
  readonly queuedAt?: Date;
}): Promise<TurnAgain> {
  // Tracked before anything else, so a stop that lands while the turn is loading still counts.
  const tracked = trackTurn(input.threadId, input.turnId, input.ended);
  try {
    return await runTrackedTurn(input, tracked.signal);
  } finally {
    tracked.release();
  }
}

interface TurnInput {
  readonly threadId: string;
  readonly turnId: string;
  readonly trigger: TurnTrigger;
  readonly ended?: AbortSignal;
  readonly queuedAt?: Date;
}

/** Begins the turn's record, runs it, and stops recording however it ends. */
async function runTrackedTurn(input: TurnInput, signal: AbortSignal): Promise<TurnAgain> {
  const { began, marker } = await markTurnBegan(input.threadId, input.turnId);
  const turn = { turn: input.turnId, began: began.toISOString() };
  const soFar = recordedAsItGoes(input.threadId, turn);
  try {
    return await runBegunTurn(input, signal, { began, marker, turn, soFar });
  } finally {
    await soFar.end();
  }
}

async function runBegunTurn(
  input: TurnInput,
  signal: AbortSignal,
  {
    began,
    marker,
    turn,
    soFar,
  }: {
    readonly began: Date;
    readonly marker: Date;
    readonly turn: Pick<TurnRecord, "turn" | "began">;
    readonly soFar: ReturnType<typeof recordedAsItGoes>;
  },
): Promise<TurnAgain> {
  const { threadId, turnId, trigger, queuedAt = new Date() } = input;
  await publishThread(threadId);
  // Published as it happens, so every step and chunk reaches the stream before the turn's end.
  const progress = (stage: TurnProgressStage) =>
    publishThreadEvent(threadId, { kind: "progress", turnId, stage });

  const [context] = await db
    .select({ thread: threads, specialist: specialists })
    .from(threads)
    .leftJoin(specialists, eq(specialists.id, threads.specialistId))
    .where(eq(threads.id, threadId));
  if (!context) throw new Error(`Thread ${threadId} not found.`);

  const visible = visibleMessages(await threadMessages(threadId));
  const prompt = renderTurnPrompt(visible, trigger);
  if (prompt === undefined) {
    await endTurn(threadId, turn, {});
    await publishThread(threadId);
    return undefined;
  }

  progress("workspace");

  const role = chooseRole(
    context.thread,
    visible.filter((message) => message.role === "user").length,
  );
  const [place, waiting, arrived, wallets, me] = await Promise.all([
    context.specialist ? specialistContext(context.specialist) : auniContext(),
    waitingCardsContext(threadId),
    arrivalsPromptContext(),
    // A lookup that fails only costs the agent the addresses, never the turn.
    walletAddresses().catch(() => null),
    theOwner(),
  ]);
  const messageId = randomUUID();
  const origin = trigger.kind === "message" ? "human" : "automation";
  const replyToId =
    trigger.kind === "message" ? trigger.messageId : visible.findLast((m) => m.role === "user")?.id;
  const reason = trigger.kind === "background" ? trigger.reason : undefined;
  const fires = trigger.kind === "background" ? trigger.fires : undefined;
  const briefed = trigger.kind === "background" ? trigger.briefed : undefined;
  const startedAt = Date.now();
  // From the moment the message was stored (its turn was queued with it), so the wait behind a
  // turn before it and the CLI's start count too.
  const waitedFrom = (trigger.kind === "message" ? queuedAt : began).getTime();
  const stages: Record<string, number> = { running: startedAt - waitedFrom };
  const metadata = {
    createdAt: began.toISOString(),
    origin,
    ...(replyToId ? { replyToId } : {}),
    ...(reason ? { reason } : {}),
    ...(fires ? { fires } : {}),
  };

  const picked = await pickBrain();
  const brain = "about" in picked ? picked.about.id : undefined;
  // No brain could think, and one the owner can make ready from the app would: the web app asks
  // for it there (its sign-in), and sends the message again once one is ready.
  const noBrain = "fixes" in picked && !picked.blocked;
  let result: TurnResult;
  try {
    if ("fixes" in picked) throw new Error("no brain is ready on this machine");
    result = await runTurn({
      picked,
      turn: {
        systemPrompt: await systemPrompt(picked.brain),
        prompt: promptBlocks(
          prompt,
          turnContext({
            owner: me,
            placeContext: [place, waiting, arrived, await declinedOffers(me.timeZone, wallets)]
              .filter(Boolean)
              .join("\n"),
            wallets,
            now: new Date(),
          }),
        ),
        role,
        box: await brainBox(),
        // The API serves MCP on this machine; the CLI that calls it runs outside its own sandbox.
        mcp: {
          url: `http://127.0.0.1:${env.PORT}/mcp`,
          token: await signTurnToken(
            { threadId, turnStartedAt: marker.toISOString() },
            env.TURN_TOKEN_SECRET,
          ),
        },
      },
      messageId,
      metadata,
      signal,
      onChunk: async (chunk) => {
        // A card is saved before the owner sees it, so a turn cut off keeps every card it showed.
        if (chunk.type === "data-cards")
          await soFar.before({ type: chunk.type, id: chunk.id, data: chunk.data });
        publishThreadEvent(threadId, { kind: "chunks", turnId, chunks: [chunk] });
      },
      onMessage: (message) => soFar.save(message.parts),
      onReady: () => {
        stages.thinking = Date.now() - waitedFrom;
        progress("thinking");
      },
    });
  } catch (error) {
    result = {
      message: { id: messageId, role: "assistant", parts: [] },
      stopped: signal.aborted,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await soFar.end();
  if (env.AUNI_DEBUG)
    console.info(
      `turn timing ${JSON.stringify({ threadId, brain, role, model: result.model, ms: stages })}`,
    );
  // Ended by Auni stopping or the machine sleeping: cut off, which the owner didn't ask for.
  const cut = result.stopped && input.ended?.aborted === true;
  const stopped = result.stopped && !cut;
  // A turn cut off by a usage limit didn't finish, whatever the CLI made of it.
  const failed = Boolean(result.error || result.limit) || cut;
  // No AI to think with is the owner's to fix, and the answer says how: nothing went wrong here.
  if (result.error && !noBrain)
    console.error(`turn ${turnId} on thread ${threadId} failed: ${result.error}`);

  // Nobody waits on a background turn, and what woke it (a fire, the brief, a move landing) lives
  // only in its job: one that failed before doing anything keeps and sends nothing and runs again
  // later, at once when only cut off. One that did anything is kept as it is and never run again,
  // so no move is repeated.
  const seen = { parts: result.message.parts, usedTool: soFar.usedTool };
  const retry =
    trigger.kind === "background" &&
    failed &&
    !stopped &&
    (await didNothing(threadId, began, seen));
  if (retry && (cut || Date.now() - queuedAt.getTime() < RETRY_FOR_MS)) {
    // Not ended: it runs again as this same turn, and begins its record afresh.
    await markTurnEnded(threadId, turn);
    await publishThread(threadId);
    publishThreadEvent(threadId, { kind: "turn-end", turnId, failed: true });
    return { again: cut ? 0 : await retryIn(result) };
  }
  if (cut || stopped) {
    const parts = stopped
      ? askingAgain(result.message.parts)
      : cutOff(result.message.parts, await cutOffWords(threadId, began, seen));
    result = { ...result, message: { ...result.message, parts } };
  }
  const notice = cut ? null : retry ? GAVE_UP : await turnNotice(result, picked, me.timeZone);
  if (notice) result = { ...result, message: withNotice(result.message, notice) };

  // A failure with nothing to show leaves no answer behind; a stopped one always shows the way
  // to ask again, however short it was.
  const keep = result.message.parts.length > 0;
  // Kept for the agent's own history, but nothing to tell: no unread mark, no notice.
  const quiet = trigger.kind === "background" ? settledQuietly(result.message.parts) : undefined;
  // One the owner stopped, in the web app, ends there.
  const channel = stopped ? null : await answersOn({ trigger, visible, tells: keep && !quiet });
  const deliver = channel ? { channel, threadId, ...(keep ? { messageId } : {}) } : null;
  // The answer, the job that sends it and the turn's end are one write: a stored answer is always
  // sent, only a stored one is, and a turn whose answer is kept has ended, so if Auni dies the
  // next instant it is never run again, nor said to be cut off.
  const keeps = async (tx: Tx) => {
    if (keep)
      await tx.insert(messages).values({
        id: messageId,
        threadId,
        role: "assistant",
        parts: result.message.parts,
        origin,
        metadata: {
          ...(stopped ? { stopped: true } : {}),
          ...(failed ? { failed: true } : {}),
          workDurationMs: Date.now() - startedAt,
          ...(brain ? { brain } : {}),
          ...(noBrain ? { noBrain: true } : {}),
          ...(result.model ? { model: result.model } : {}),
          ...(result.login ? { login: result.login } : {}),
          ...(reason ? { reason } : {}),
          ...(fires ? { fires } : {}),
          ...(quiet ? { quiet } : {}),
        },
        // Ordered at the turn's start, so a message sent while it ran sorts after it.
        createdAt: began,
      });
    if (deliver) await deliverKind.enqueue(tx, deliver);
    // What it tells of is told only with an answer that didn't fail.
    if (!keep || failed) return;
    if (fires) {
      const outcome = quiet
        ? `Stayed quiet: ${quiet}`.slice(0, 200)
        : openingLine(messageText(result.message.parts));
      await settleFires(
        tx,
        fires.map(({ fireId }) => fireId),
        messageId,
        outcome,
      );
    }
    if (briefed) await markBriefed(tx, briefed);
  };
  // An answer left behind is unread until the owner opens the thread after it.
  await endTurn(threadId, turn, { keeps, replied: keep && !quiet });
  if (keep) await landLate(threadId, began, result.message.parts);
  await publishThread(threadId);
  // An answer that only asks for an AI is that answer, not a failure for the browser to show.
  const showsFailed = failed && !noBrain;
  publishThreadEvent(threadId, { kind: "turn-end", turnId, ...(showsFailed ? { failed } : {}) });
  return undefined;
}

/** The moves and plans the cards among `parts` are about. */
function cardsShown(parts: readonly unknown[]): Set<string> {
  const shown = new Set<string>();
  for (const part of parts as { type: string; data?: { cards?: unknown[] } }[]) {
    if (part.type !== "data-cards") continue;
    for (const card of (part.data?.cards ?? []) as {
      actionReference?: unknown;
      proposalId?: unknown;
    }[])
      for (const id of [card.actionReference, card.proposalId])
        if (typeof id === "string") shown.add(id);
  }
  return shown;
}

/**
 * A turn whose run was cut off midway with Auni's process (the job runner finds it so as Auni
 * starts again), or which threw, judged from its record alone (turn-record.ts). One that had
 * ended, its answer kept if it left one, is left as it is: never run again, nothing added. A
 * background turn that did nothing (didNothing) runs again, on its first run only, so a turn
 * that brings Auni down can't loop. Any other is kept as far as the owner saw it, saved as it
 * went, with a line saying it was cut off and one reply that asks again; a card on it still
 * stands, and one recorded in its last instant that never reached the owner is retired, so
 * nothing waits on a tap they can't see.
 */
export async function keepCutTurn(input: {
  readonly threadId: string;
  readonly turnId: string;
  readonly trigger: TurnTrigger;
  readonly firstRun: boolean;
}): Promise<"rerun" | undefined> {
  const { threadId, turnId, trigger } = input;
  const [thread] = await db
    .select({ marker: threads.turnStartedAt })
    .from(threads)
    .where(eq(threads.id, threadId));
  if (!thread) return undefined;
  const record = await recordOf(threadId, turnId);
  const told = async (failed: boolean) => {
    await publishThread(threadId);
    publishThreadEvent(threadId, { kind: "turn-end", turnId, ...(failed ? { failed } : {}) });
  };
  if (record?.ended) {
    await told(false);
    return undefined;
  }
  // One that never began its record did nothing, from when its marker was set, or from now.
  const began = record ? new Date(record.began) : (thread.marker ?? new Date());
  const seen = record ?? { parts: [] };
  if (
    trigger.kind === "background" &&
    input.firstRun &&
    (await didNothing(threadId, began, seen))
  ) {
    await markTurnEnded(threadId, { turn: turnId, began: began.toISOString() });
    await told(true);
    return "rerun";
  }

  const visible = visibleMessages(await threadMessages(threadId));
  const channel = await answersOn({ trigger, visible, tells: true });
  const messageId = randomUUID();
  const shown = [...cardsShown(seen.parts)];
  const words = await cutOffWords(threadId, began, seen);
  await endTurn(
    threadId,
    { turn: turnId, began: began.toISOString() },
    {
      replied: true,
      keeps: async (tx) => {
        await step(
          tx,
          "replace",
          and(
            eq(actions.threadId, threadId),
            gte(actions.createdAt, began),
            shown.length > 0 ? notInArray(actions.id, shown) : undefined,
            shown.length > 0
              ? or(isNull(actions.proposalId), notInArray(actions.proposalId, shown))
              : undefined,
          ),
        );
        await tx.insert(messages).values({
          id: messageId,
          threadId,
          role: "assistant",
          parts: cutOff(seen.parts, words),
          origin: trigger.kind === "message" ? "human" : "automation",
          metadata: {
            failed: true,
            ...(trigger.kind === "background" ? { reason: trigger.reason } : {}),
            ...(trigger.kind === "background" && trigger.fires ? { fires: trigger.fires } : {}),
          },
          createdAt: began,
        });
        if (channel) await deliverKind.enqueue(tx, { channel, threadId, messageId });
      },
    },
  );
  await told(true);
  return undefined;
}
