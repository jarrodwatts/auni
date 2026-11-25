import { z } from "zod";

import { publishThread } from "../conversation/threads.ts";
import { db } from "../db/client.ts";
import type { ActionRow } from "../db/schema.ts";
import { executeAction, settledOutcome, settleStopped } from "../money/actions.ts";
import { SETTLED } from "../money/life.ts";
import { PICKS, stagedLeg } from "../money/proposal-order.ts";
import { advanceProposal, stalledProposals } from "../money/proposal-run.ts";
import { markCrashed, requireAction, settleLanding } from "../money/record.ts";
import { reconcileStuckActions } from "../money/reconcile.ts";
import { retractStale } from "../money/waiting.ts";
import { actionKind, landingKind, proposalKind, wakeThread } from "./kinds.ts";
import { defineJob, jobKind, type Executor } from "./queue.ts";

/**
 * Runs a move the owner allowed (or its specialist made on its own), once. Moves sharing a lane
 * (a venue that takes one at a time, one holding) wait their turn (see executionKeys). Never
 * retried: executeAction's claim makes a second run a no-op, and once it claimed the row, a run
 * cut off midway may have sent, so it is marked crashed for reconcile, never run again. What a
 * restart does in each state of a move is in money/life.ts.
 */
export const actionJob = defineJob({
  kind: actionKind,
  run: async ({ actionId }) => afterRun(await executeAction(actionId)),
  cutShort: async ({ actionId }) => {
    // Cut off before it claimed the move: nothing was tried, so it runs.
    if ((await requireAction(actionId)).phase === "queued") return "rerun";
    // Only a move still sending is stopped, and read once as a run that threw is; one already
    // landing or settled is told as it stands.
    await afterRun(await settleStopped(await markCrashed(actionId)));
  },
});

/** A bridge or a deposit into a venue's account lands within minutes, so it is checked often for the first fifteen. */
const OFTEN_FOR_MS = 15 * 60_000;

/**
 * Watches money a move sent across to another network or venue until it lands, then tells the
 * thread what landed: every ten seconds at first, then every five minutes until its recipe says
 * how it ended or the landing window passes (see settleLanding). A check changes nothing until
 * it lands, so it is safe to run again.
 */
export const landingJob = defineJob({
  kind: landingKind,
  retries: 4,
  run: async ({ actionId }) => {
    const row = await settleLanding(actionId);
    const age = Date.now() - (row.startedAt?.getTime() ?? 0);
    if (row.phase === "landing") return { again: age < OFTEN_FOR_MS ? 10_000 : 5 * 60_000 };
    await publishSettled(row);
    await tellSettled(db, row);
  },
});

/** About three minutes for money a bridge sent to land before the next stage starts anyway. */
const PATIENT_MS = 3 * 60_000;

/**
 * Moves a proposal on once one of its money moves settles: the next stage starts when the money
 * it spends has landed, or everything after a move that didn't go through is stopped. One at a
 * time a proposal; it stops only legs not yet claimed, so it is safe to run again.
 */
export const proposalJob = defineJob({
  kind: proposalKind,
  run: async ({ proposalId }, job) => {
    const patient = Date.now() - job.createdAt.getTime() < PATIENT_MS;
    const advanced = await advanceProposal(proposalId, patient);
    if (advanced.wake) {
      await wakeThread(advanced.wake.threadId, advanced.wake.reason.slice(0, 2_000), {
        key: advanced.wake.id,
      });
    }
    if (advanced.waiting) return { again: 5_000 };
  },
});

/**
 * Every 10 minutes, settles moves whose money moved but whose result was never recorded (see
 * reconcileStuckActions), and tells their threads and moves their proposals on as a finished
 * run would have. Proposals whose next stage never started move on.
 */
export const reconcileJob = defineJob({
  kind: jobKind("reconcile", z.object({})),
  every: 10 * 60_000,
  run: async () => {
    const stalled = await stalledProposals();
    const settled = await reconcileStuckActions();
    for (const row of settled) {
      await publishSettled(row);
      await tellSettled(db, row).catch((error: unknown) =>
        console.error(`reconciled action ${row.id} told no one`, error),
      );
    }
    for (const proposalId of stalled) await proposalKind.enqueue(db, { proposalId });
  },
});

/**
 * Every 10 minutes, takes back the cards that have waited a day for the owner's tap, or were drawn
 * before cards said all they say now (see retractStale), and tells their threads' open tabs.
 */
export const staleCardsJob = defineJob({
  kind: jobKind("stale-cards", z.object({})),
  every: 10 * 60_000,
  run: async () => {
    for (const threadId of await retractStale(db)) await publishThread(threadId);
  },
});

/**
 * Tells of a move settled outside any job (the owner's Check again or Close on a held one), as
 * a run that settled it would have: its thread's row, its thread, and its proposal's next stage.
 */
export async function toldSettled(row: ActionRow): Promise<void> {
  await publishSettled(row);
  await tellSettled(db, row);
}

/** After a run: watches money on its way until it lands, or tells what settled. */
async function afterRun(row: ActionRow): Promise<void> {
  await publishSettled(row);
  if (row.phase === "landing")
    await landingKind.enqueue(
      db,
      { actionId: row.id },
      { key: `landing-${row.id}-a${row.attempts}` },
    );
  else await tellSettled(db, row);
}

/**
 * Tells the open tabs a move settled: its thread's row counts the legs that went through,
 * live. A move still running changed nothing the row counts.
 */
async function publishSettled(row: ActionRow): Promise<void> {
  if (row.threadId && SETTLED.includes(row.status)) await publishThread(row.threadId);
}

/**
 * Wakes the thread of a settled move, once every leg of its proposal has, and lets the proposal
 * go on to its next stage, or stop. Each keyed to this run of the move, so a second telling
 * (two legs settling at once, a run cut off after it told) wakes and advances once.
 */
async function tellSettled(executor: Executor, row: ActionRow): Promise<void> {
  if (!SETTLED.includes(row.status)) return;
  if (row.proposalId && stagedLeg(row).stage < PICKS)
    await proposalKind.enqueue(
      executor,
      { proposalId: row.proposalId },
      { key: `proposal-advance-${row.id}-a${row.attempts}` },
    );
  // A withdrawal from Settings has no conversation to tell.
  if (!row.threadId) return;
  const settled = await settledOutcome(row);
  if (!settled) return;
  await wakeThread(row.threadId, settled.reason.slice(0, 2_000), {
    key: settled.id,
    tx: executor,
  });
}
