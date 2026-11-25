import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { publishThread } from "../conversation/threads.ts";
import { db } from "../db/client.ts";
import { actions } from "../db/schema.ts";
import { lockLegs, queueExecution, settledOutcome } from "./actions.ts";
import { cashCents } from "./funding.ts";
import { step } from "./life.ts";
import { awaitedCash, nextStep, stagedLeg } from "./proposal-order.ts";
import type { CashPlace } from "./recipe.ts";

// Running a proposal in order (see proposal-order.ts): its first stage on the
// tap, and each later one as the stage before it settles.

const STOPPED = "Skipped: the money for it couldn't be moved first, so nothing was spent.";

interface Advanced {
  /** The next stage spends money a move sent that hasn't landed yet: ask again shortly. */
  readonly waiting: boolean;
  /** What to wake the agent with, once stopping the rest settled every leg, and the wake's id. */
  readonly wake: { readonly threadId: string; readonly reason: string; readonly id: string } | null;
}

/**
 * After one of a proposal's money moves settles: stops the legs a move that
 * didn't go through was to pay for (see nextStep), then starts the next stage.
 * `patient` waits for the money a bridge sent to land first; once patience
 * runs out the stage starts anyway, and each leg's own balance check refuses
 * to spend money that isn't there.
 */
export async function advanceProposal(proposalId: string, patient: boolean): Promise<Advanced> {
  const rows = await db.select().from(actions).where(eq(actions.proposalId, proposalId));
  const legs = rows.map(stagedLeg);
  const next = nextStep(legs);
  if (next.kind === "none") return { waiting: false, wake: null };
  if (next.kind === "stop") {
    // Only legs still queued: one the executor already claimed runs its course.
    // Locked as a leg's start locks them, so stopping several as another leg starts never deadlocks.
    const stopped = await db.transaction(async (tx) => {
      await lockLegs(tx, eq(actions.proposalId, proposalId));
      return step(tx, "skip", inArray(actions.id, [...next.ids]), {
        error: STOPPED,
        failureKind: "stopped",
      });
    });
    const [first] = stopped;
    if (!first) return { waiting: false, wake: null };
    if (first.threadId) {
      await publishThread(first.threadId);
      const settled = await settledOutcome(first);
      if (settled) return { waiting: false, wake: { threadId: first.threadId, ...settled } };
    }
    // Legs it didn't stop still run, once the moves before them have. This stopped at least one
    // leg and stranded leaves none for a second stop, so it calls itself once.
    return advanceProposal(proposalId, patient);
  }

  const awaited = awaitedCash(legs, next.stage);
  if (patient && awaited.size > 0 && !(await holds(awaited))) return { waiting: true, wake: null };
  await queueExecution(
    db,
    rows.filter((row) => row.phase === "queued" && next.ids.includes(row.id)),
  );
  return { waiting: false, wake: null };
}

/** Whether every place holds what is awaited from it; one that can't be read yet doesn't. */
async function holds(awaited: ReadonlyMap<CashPlace, bigint>): Promise<boolean> {
  try {
    const held = await Promise.all(
      [...awaited].map(async ([place, cents]) => (await cashCents(place)) >= cents),
    );
    return held.every(Boolean);
  } catch (error) {
    console.warn("proposal wallets unreadable", error);
    return false;
  }
}

/** Longer than a stage takes to run and land, so legs unstarted this long lost the job that starts them. */
const STALLED_AFTER = "15 minutes";

/** Proposals with legs allowed but never started long after the tap. */
export async function stalledProposals(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ proposalId: actions.proposalId })
    .from(actions)
    .where(
      and(
        eq(actions.phase, "queued"),
        isNotNull(actions.proposalId),
        lt(actions.updatedAt, sql`now() - ${STALLED_AFTER}::interval`),
      ),
    )
    .limit(100);
  return rows.flatMap((row) => (row.proposalId ? [row.proposalId] : []));
}
