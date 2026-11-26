import { RETRACTED, type ActionStatus, type MovePhase, type MoveRun } from "@auni/shared";
import { and, inArray, sql, type SQL } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import type { Tx } from "../db/client.ts";
import { actions, type ActionRow } from "../db/schema.ts";

/**
 * A move's life: every state a move can be in, every step between them, who takes each step, and
 * what a restart does in each state. A move's state changes nowhere else: every change is one
 * `step`, a new row starts with `begins`, and ESLint refuses a write of `status`, `phase`,
 * `startedAt` or `endedAt` to the actions table in any other file (eslint.config.mjs).
 *
 * A row's `status` is where its card stands. While it is `running`, its `phase` says how far the
 * run has got. So a move's state is its phase while it runs, and its status otherwise. Each
 * step, where it leads, and who takes it:
 *
 *   awaiting_permission
 *     |- decline -> cancelled      the owner's tap (decideActions)
 *     |- replace -> replaced       a newer card that names it (recordActions), or a specialist's
 *     |                            newer plan; a cut-off turn's card the owner never saw
 *     |- retract -> retracted      Auni takes it back, saying why (RETRACTED): the agent
 *     |                            (retract_cards), a day untapped or a card from before
 *     |                            (retractStale), its specialist retired, or what it sells
 *     |                            moved (move_holding)
 *     '- allow ---> queued         the owner's tap (decideActions); one a specialist makes on
 *          |                       its own starts here, as does one a card showed coming later
 *          |                       (ExecuteResult.later), its job due then
 *          |- skip --> failed      the proposal job, for a leg whose money never came; an
 *          |                       allowed ask that no longer applies; the action job, for a
 *          |                       leg allowed on a card from before that didn't show a
 *          |                       permission it leaves, once its plan has started (startRun)
 *          |- apply -> done        the Allow that decides an ask, in its own transaction
 *          |- recall -> retracted  the action job, in place of its claim: allowed on a card from
 *          |                       before that didn't show a permission it leaves
 *          |                       (leftOutPermission), with every leg of its plan, while none
 *          |                       has started (startRun)
 *          '- claim -> sending     the action job, once (executeAction)
 *               |- finish -> done        the run
 *               |- fail ---> failed      the run, when nothing moved
 *               |- depart -> landing     the run, in the write that records its send
 *               |     '- finish -> done  the landing job, once it landed or its window passed
 *               '- stop ---> unsure      the run, when it threw having sent or maybe sent;
 *                     |                  cutShort, for a run that died
 *                     |- finish -> done         reconcile, from its receipts, or from what its
 *                     |                         recipe reads back of a trade (Recipe.readBack)
 *                     |- fail ---> failed       reconcile, when every send reverted
 *                     '- hold ---> needs_owner  reconcile, when nothing it can read says what the
 *                           |                   move did; its thread is woken in the same write
 *                           |- finish -> done   reconcile or the owner's Check again, once a read
 *                           |                   answers; the owner's Close, when its money moved
 *                           '- fail ---> failed the same, when a read says nothing moved; the
 *                                               owner's Close, when nothing shows that it did
 *   failed --retry--> queued       the owner's Try again, as the row's next attempt
 *
 * | State | What it means | What a restart does |
 * |---|---|---|
 * | awaiting_permission | Its card waits for the owner's tap, for a day at most (CARD_WAITS_MS). | Nothing: it waits. |
 * | queued | Allowed, with its `action` job queued in the same transaction. A plan's later legs wait here for their stage. | The runner runs its job; a job cut off before the claim runs again. |
 * | sending | Its job claimed it and its recipe is sending. | Its job was cut off, so `cutShort` stops it: unsure if it kept a send, its receipts read once as a run that threw has them read, else failed as "sent", which a tap never runs again. The wallet then resends what it signed and never broadcast, the same bytes. |
 * | landing | Sent, and its money arrives later (a bridge, a deposit). | The `landing` job checks again; it only reads. |
 * | unsure | It stopped with something sent, or maybe sent. | Reconcile, every ten minutes, reads the receipts of a move started over 30 minutes ago (STUCK_AFTER_MS) and finishes or fails it; a trade whose sends confirmed is recorded from what its recipe reads back. It does the same for a move left sending that long, whose outcome couldn't be written. |
 * | needs_owner | Held: it sent, or may have, and nothing Auni can read says what it did (HELD in shared names the three ways: a confirmed trade with no way to read it back, a send its venue never answered, a send unconfirmed after a day). Its card says so with Check status and Dismiss card, its thread was woken once, and it counts against its specialist's pot as spent (money/pot.ts). | Reconcile reads it again every ten minutes and settles it if the world now answers. Nothing is ever sent again. |
 * | done | It went through. A venue's own doing (a payout, a liquidation) is recorded done too. | Nothing. |
 * | failed | Nothing moved, or what did is in its transactions. Try again may run it once more. | Nothing. |
 * | cancelled, replaced, retracted | Declined, a newer card took its place, or Auni took it back and its `error` says why. | Nothing. |
 */
export type MoveState = Exclude<ActionStatus, "running"> | MovePhase;

/** States nothing leaves but the owner's Try again on a failed one. */
export const SETTLED: readonly ActionStatus[] = [
  "done",
  "failed",
  "cancelled",
  "replaced",
  "retracted",
];

const now = sql`now()`;
/** When a run ended: the first step out of sending, kept through landing or unsure to done. */
const ended = sql`coalesce(${actions.endedAt}, now())`;

/** Every step: the states it is taken from, the state it leaves, and what it always writes. */
export const STEPS = {
  allow: { from: ["awaiting_permission"], to: "queued" },
  decline: { from: ["awaiting_permission"], to: "cancelled" },
  replace: { from: ["awaiting_permission"], to: "replaced" },
  retract: { from: ["awaiting_permission"], to: "retracted" },
  recall: { from: ["queued"], to: "retracted" },
  claim: { from: ["queued"], to: "sending", also: { startedAt: now } },
  skip: { from: ["queued"], to: "failed" },
  apply: { from: ["queued"], to: "done" },
  depart: { from: ["sending"], to: "landing", also: { endedAt: ended } },
  stop: { from: ["sending"], to: "unsure", also: { endedAt: ended } },
  hold: { from: ["sending", "unsure"], to: "needs_owner", also: { endedAt: ended } },
  finish: {
    from: ["sending", "landing", "unsure", "needs_owner"],
    to: "done",
    also: { failureKind: null, endedAt: ended },
  },
  fail: { from: ["sending", "unsure", "needs_owner"], to: "failed", also: { endedAt: ended } },
  retry: {
    from: ["failed"],
    to: "queued",
    also: { startedAt: null, endedAt: null, error: null, failureKind: null, run: {} },
  },
} as const satisfies Record<
  string,
  { from: readonly MoveState[]; to: MoveState; also?: PgUpdateSetSource<typeof actions> }
>;
export type Step = keyof typeof STEPS;

/** What a step may write beside the state: never the state itself, nor the card's details. */
type Written = Omit<
  PgUpdateSetSource<typeof actions>,
  "status" | "phase" | "startedAt" | "endedAt" | "details" | "updatedAt"
>;

/** The two columns that say `state`. */
function columns(state: MoveState): Pick<ActionRow, "status" | "phase"> {
  return (SETTLED as readonly string[]).includes(state) || state === "awaiting_permission"
    ? { status: state as ActionStatus, phase: null }
    : { status: "running", phase: state as MovePhase };
}

/**
 * The state a new row starts in: a card waiting for the owner, a move its specialist makes on
 * its own (queued in the same transaction), or a record of what a venue did by itself.
 */
export const begins = (state: "awaiting_permission" | "queued" | "done") => columns(state);

/**
 * Takes one step with every move `which` picks that is in a state the step may be taken from,
 * in one conditional write, and returns the moves it moved. A move in any other state is left
 * exactly as it was, so a step taken twice, or too late, changes nothing. `which` is undefined
 * when drizzle's `and()` or `or()` is handed no conditions, and then it picks no move, never all.
 */
export function step(
  executor: Pick<Tx, "update">,
  name: Step,
  which: SQL | undefined,
  write: Written = {},
): Promise<ActionRow[]> {
  const { from, to, also }: (typeof STEPS)[Step] & { also?: object } = STEPS[name];
  return executor
    .update(actions)
    .set({ ...write, ...also, ...columns(to), updatedAt: now })
    .where(
      and(
        which ?? sql`false`,
        inArray(sql`coalesce(${actions.phase}, ${actions.status})`, [...from]),
      ),
    )
    .returning();
}

/** Takes back the waiting cards `which` picks, saying why in the words RETRACTED gives. */
export function retract(
  executor: Pick<Tx, "update">,
  which: SQL | undefined,
  why: keyof typeof RETRACTED,
): Promise<ActionRow[]> {
  return step(executor, "retract", which, { error: RETRACTED[why] });
}

/** A run's notes added to the ones its row holds, for a step or a write to set as `run`. */
export function noted(notes: MoveRun): SQL {
  return sql`${actions.run} || ${JSON.stringify(notes)}::jsonb`;
}
