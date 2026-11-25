import { CARD_FORMAT, RAW_TRANSACTION_TOOLS, RETRACTED, type actionWireSchema } from "@auni/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { toolInput } from "../agent/tool.ts";
import { appById, closedHere, ledgerAt } from "../apps/registry.ts";
import { applyAsk, isAsk } from "../asks.ts";
import { publishThread } from "../conversation/threads.ts";
import { db, type Tx } from "../db/client.ts";
import { actions, threads, type ActionRow } from "../db/schema.ts";
import { actionKind, wakeThread } from "../jobs/kinds.ts";
import type { Executor } from "../jobs/queue.ts";
import { APPROVED_SALE, APPROVED_SALE_OF } from "./approved.ts";
import { fitted, leftOutPermission, tooMuchToWarn, withPermissions } from "./card-face.ts";
import { approval, effectLines, pinnedApproval } from "./effect.ts";
import { failureKind, retryRefusal } from "./failure.ts";
import { fillIdentity, tokenKey, type FillKey } from "./fill-key.ts";
import { begins, SETTLED, step } from "./life.ts";
import { feeCoinFor, payingFees, topUpFor } from "./fee-coin.ts";
import { lostSaid } from "./gone-for-good.ts";
import { feeCoinTrades, feeCoinUsd, pinned, withFeeCoin, withoutFeeCoin } from "./fee-coin-said.ts";
import { unpaid } from "./funding.ts";
import { countBeforeTrading } from "./other-tokens.ts";
import { permissionDecision } from "./permission.ts";
import { cashOf, nextStep, stagedLeg, stageOf } from "./proposal-order.ts";
import { buyingSolOnce } from "./sol-top-up.ts";
import { shownHoldings } from "./raw-transaction.ts";
import { heldNow } from "./portfolio.ts";
import { recordOwnFills } from "./statements.ts";
import { assertStepUp } from "./step-up.ts";
import { lockCards, threadPot } from "./pot.ts";
import {
  MayHaveSent,
  NothingMoved,
  type ActionPreview,
  type CashPlace,
  type ExecuteResult,
  type KeptTx,
  type Later,
  subjectOf,
  type Recipe,
} from "./recipe.ts";
import { recipeForTool, toolRecipe } from "./recipes/index.ts";
import { Refused } from "./refused.ts";
import { replaceCards, retractStale, type WaitingCard } from "./waiting.ts";
import { errorWords } from "../safe-words.ts";
import { settleFromReceipts } from "./reconcile.ts";
import {
  dropMark,
  finish,
  keepTxs,
  keepTxsSafely,
  markFailed,
  markStopped,
  recordResult,
  requireAction,
  retried,
  soldHolding,
  type HeldBefore,
} from "./record.ts";
import { dollars } from "./summaries.ts";
import { normalizeUsd, parseUnits } from "./usd.ts";
import { signerFor } from "./wallets.ts";
import { chainKey, placeName } from "./chains.ts";

export interface ActionContext {
  /** Null for a move started outside every conversation (a withdrawal from Settings). */
  readonly threadId: string | null;
}

interface ProposeOutcome {
  /** Running: its thread acts on its own within its budget, and its job is queued to run it. */
  readonly status: "awaiting_permission" | "running";
  readonly action: ActionRow;
  /** The waiting cards it took the place of (see replaceCards). */
  readonly replaced: readonly WaitingCard[];
}

/** A recipe call checked and priced, not yet recorded. */
export interface PreparedLeg {
  readonly recipe: Recipe;
  readonly input: Record<string, unknown>;
  readonly preview: ActionPreview;
}

/** Where a prepared leg's cash comes from and goes, as a plan's funding reads it. */
export function plannedCash({ recipe, input, preview }: PreparedLeg) {
  return cashOf(recipe, input, preview.details ?? {}, preview.amountUsd);
}

/**
 * Refuses a card that can't go through for the cash where it spends, before
 * the person sees it, telling the agent what's short so it can bring their cash
 * from wherever else it sits or use propose_actions so the card offers Add money.
 */
export async function mustBePaid(legs: readonly ReturnType<typeof plannedCash>[]): Promise<void> {
  const short = await unpaid(legs);
  if (!short) return;
  throw new Error(
    `Nothing was recorded, and the owner saw nothing: ${short}. Money still on its way there ` +
      "counts once it lands. Cash they hold elsewhere can pay for it on the same card: " +
      "propose_actions with the moves that bring it first (get_portfolio shows where it sits), " +
      "which also converts eligible holdings or shows an Add money button when cash is short.",
  );
}

export async function prepareLeg(
  recipe: Recipe,
  rawInput: unknown,
  { heldTo }: { readonly heldTo?: Pick<ActionRow, "details"> } = {},
): Promise<PreparedLeg> {
  const input = toolInput(recipe.input).parse(rawInput);
  const closed = await buyClosedHere(recipe, input);
  if (closed) throw new Error(closed);
  const described = await recipe.describe(input, { heldTo });
  // Where the wallet is short of the chain's coin for what the card would send, the card buys
  // it first, or there is no card (see fee-coin.ts). A move pins one purchase, so that coin
  // takes the place of any SOL it buys, which another move on its card then buys for it, or
  // there is no card (see buyingSolOnce).
  const bought = described.sends ? await feeCoinFor(described.sends) : null;
  const preview = bought ? withFeeCoin(withoutFeeCoin(described), bought) : described;
  const lost = lostSaid({ details: approvedDetails(preview) });
  const unshowable = tooMuchToWarn(preview.effect, lost);
  if (unshowable) throw new Error(unshowable);
  // The most it may spend, which a tap allows and execute holds it to (see assertApprovedSpend).
  return {
    recipe,
    input,
    preview: { ...preview, amountUsd: normalizeUsd(preview.amountUsd, "up") },
  };
}

/**
 * Why the app a buy is at takes no new positions from this machine now (App.noNewPositions), or
 * null. Asked before a card is made, so no card (nor any move on it that brings cash) is offered
 * for a buy the service would refuse, and again before an allowed one runs.
 */
async function buyClosedHere(
  recipe: Recipe,
  input: Record<string, unknown>,
): Promise<string | null> {
  if (recipe.direction?.(input) !== "buy") return null;
  return (await closedHere(appById(recipe.venue)))?.says ?? null;
}

/**
 * The legs of one card, buying each chain's coin for its fees once: SOL for every leg after the
 * first that needs it (see buyingSolOnce), and the coin of an EVM chain kept from running out
 * there (see topUpFor in fee-coin.ts): on a chain whose coin the card's moves would leave low,
 * its first move there that buys nothing else first swaps a little of the chain's cash for it,
 * where the card's own sums still pay for that. A chain whose coin a move there already buys
 * needs no more.
 */
export async function keepingFees(legs: readonly PreparedLeg[]): Promise<PreparedLeg[]> {
  let kept = await buyingSolOnce(legs, solStage);
  const chains = new Set(legs.flatMap(({ preview }) => preview.sends?.chainId ?? []));
  for (const chainId of chains) {
    const there = kept.filter(({ preview }) => preview.sends?.chainId === chainId);
    // A card pins one purchase a move, so a move that buys SOL takes no swap here too.
    const first = there.find(({ preview }) => !pinned(preview.details ?? {}));
    const buys = there.some(
      ({ preview }) => pinned(preview.details ?? {})?.chain === chainKey(chainId),
    );
    if (!first || buys) continue;
    const bought = await topUpFor(chainId, there.length).catch(() => null);
    if (!bought) continue;
    const topped = kept.with(kept.indexOf(first), {
      ...first,
      preview: withFeeCoin(first.preview, bought),
    });
    if ((await unpaid(topped.map(plannedCash))) === null) kept = topped;
  }
  return kept;
}

/** The stage a leg runs in, by its cash, as buying a card's SOL once weighs it. */
const solStage = (leg: PreparedLeg) => stageOf(plannedCash(leg));

/**
 * Checks and prices every leg of a card one tap allows, one at a time: venue
 * quote APIs (a Solana route's) rate-limit a burst of parallel quotes. Money
 * leaving the owner or a move that can need the owner's proof is its own card,
 * never a leg. Problems name each leg that can't go, by its label.
 */
export async function prepareLegs(
  legs: readonly { readonly tool: string; readonly input: unknown; readonly label: string }[],
): Promise<{ prepared: PreparedLeg[]; problems: string[] }> {
  const prepared: PreparedLeg[] = [];
  const problems: string[] = [];
  for (const [index, leg] of legs.entries()) {
    try {
      const recipe = toolRecipe(leg.tool);
      if (!recipe) throw new Error(`${leg.tool} is not a money tool.`);
      const ready = await prepareLeg(recipe, leg.input);
      // A card's one Allow carries no proof for a leg, so a leg that could need one is its own card.
      if (approval(ready.preview.effect, []).kind !== "tap")
        throw new Error(
          `This one's card can also check it's the owner, so it is its own card: call ${recipe.tool} on its own.`,
        );
      prepared.push(ready);
    } catch (error) {
      problems.push(`Leg ${index + 1} (${leg.label}): ${plainError(error)}`);
    }
  }
  // A card buys SOL once, so the cash it is checked for from here on counts one purchase.
  if (problems.length > 0) return { prepared, problems };
  return { prepared: await buyingSolOnce(prepared, solStage), problems };
}

/**
 * Records a recipe call as an action and applies the permission gate. Unless
 * the thread is set to act on its own within a budget that fits, the row waits
 * for the owner's Allow. Otherwise its job is queued with it, and the thread
 * is woken once it settles.
 */
export async function proposeAction(
  context: ActionContext,
  recipe: Recipe,
  rawInput: unknown,
  replaces?: readonly string[],
): Promise<ProposeOutcome> {
  const prepared = await prepareLeg(recipe, rawInput);
  const [leg = prepared] = await keepingFees([prepared]);
  await mustBePaid([plannedCash(leg)]);
  const { rows, replaced } = await recordActions(context, [leg], null, replaces);
  const [action] = rows;
  if (!action) throw new Error("Failed to record the action.");
  const status = action.status === "awaiting_permission" ? action.status : "running";
  return { status, action, replaced };
}

/**
 * Records every leg in one transaction under one permission decision, made on
 * the whole plan: all of them run, or all of them wait for the owner's Allow.
 * Running legs are queued in the same transaction, a proposal's first stage
 * or a lone move, so a move that runs always has a job. The cards of this
 * thread the agent names in `replaces` are replaced, which it must say while
 * any wait (see replaceCards).
 */
export async function recordActions(
  context: ActionContext,
  legs: readonly PreparedLeg[],
  proposalId: string | null,
  replaces?: readonly string[],
): Promise<{ rows: ActionRow[]; replaced: WaitingCard[] }> {
  return db.transaction(async (tx) => {
    await lockCards(tx);
    // Lock the thread row so two plans in an auto thread can't both spend its free cash.
    const [thread] = context.threadId
      ? await tx.select().from(threads).where(eq(threads.id, context.threadId)).for("update")
      : [];
    const actsOnItsOwn =
      thread?.archivedAt === null &&
      thread.actMode === "within_limits" &&
      Number(thread.budgetUsd) > 0;
    const decision = permissionDecision({
      thread: thread
        ? {
            actsOnItsOwn,
            ...(actsOnItsOwn
              ? await threadPot(tx, thread)
              : { freeCashCents: 0n, holds: new Map<string, bigint>() }),
          }
        : null,
      legs: legs.map((leg) => ({
        direction: leg.recipe.direction?.(leg.input) ?? null,
        effect: leg.preview.effect,
        amountUsd: leg.preview.amountUsd,
        sells: leg.preview.sells ?? null,
        unpriced: leg.preview.unpriced !== undefined,
        feesUsd: feeCoinUsd(leg.preview.details ?? {}),
      })),
    });
    const runs = decision === "run";
    const replaced = await replaceCards(tx, thread?.id ?? null, replaces, undefined);
    const rows = await tx
      .insert(actions)
      .values(
        legs.map((leg) => ({
          threadId: context.threadId,
          proposalId,
          summary: leg.preview.summary,
          amountUsd: leg.preview.amountUsd,
          ...begins(runs ? "queued" : "awaiting_permission"),
          venue: leg.recipe.venue,
          tool: leg.recipe.tool,
          input: leg.input,
          lines: effectLines(leg.preview.effect),
          details: approvedDetails(leg.preview),
          // Cut to the lengths a card takes, so words from outside can't make one that fails to draw.
          // Saying every permission the move leaves, whoever wrote its face.
          card: leg.preview.card
            ? fitted(withPermissions(leg.preview.card, leg.preview.effect))
            : null,
          cardFormat: CARD_FORMAT,
        })),
      )
      .returning();
    if (runs) {
      if (proposalId) await startProposal(tx, rows);
      else await queueExecution(tx, rows);
    }
    return { rows, replaced };
  });
}

/** What a leg's action keeps of its preview: what it pinned, and the bounds its tap approves. */
export function approvedDetails(preview: ActionPreview): Record<string, string> {
  return {
    ...preview.details,
    // What the ladder weighs again when the owner taps (see step-up.ts).
    ...pinnedApproval(preview.effect),
    ...(preview.sells
      ? {
          [APPROVED_SALE]: preview.sells.quantity,
          [APPROVED_SALE_OF]: fillIdentity(preview.sells),
        }
      : {}),
  };
}

/**
 * Runs a queued move exactly once: the claim (the `claim` step of its life)
 * is atomic, so a replayed call returns the row untouched.
 * The recipe quotes fresh and sends in this one step. Once money may have
 * moved, the action is never reported failed on a guess: a recipe that threw
 * after sending is settled from its receipts, now or by reconcile, unless it
 * knows nothing moved, and one whose outcome can't be written stays running
 * for reconcile. A trade on a venue whose statement Auni reads is recorded
 * from that statement once it shows there (see recordOwnFills).
 */
export async function executeAction(actionId: string): Promise<ActionRow> {
  const claimed = await db.transaction((tx) => startRun(tx, actionId));
  if (!claimed) return requireAction(actionId);

  let result: ExecuteResult;
  let heldBefore: HeldBefore | null = null;
  try {
    // Only the Allow that decides an ask applies it (see asks.ts); nothing here ever does.
    if (isAsk(claimed.tool)) throw new NothingMoved("An ask is applied only by the owner's Allow.");
    const recipe = recipeForTool(claimed.tool);
    if (!recipe) throw new Error(`No recipe handles ${claimed.tool}.`);
    // Whatever the recipe, a move whose card takes the owner's proof runs only once it recorded it.
    await assertStepUp(claimed);
    // A token it trades that they hold while it's Other counts from before it, never as made;
    // so do the coins its card buys for fees and pays with.
    const { sale, sends, about } = tradedHoldings(claimed);
    const fees = feeCoinTrades(claimed.details);
    await countBeforeTrading([...(sale ? [sale] : []), ...sends, ...about, ...fees]);
    const input = z.object(recipe.input).parse(claimed.input);
    // Before anything is sent, even the coin for its fees.
    const closed = await buyClosedHere(recipe, input);
    if (closed) throw new Refused("rule", closed);
    // Each transaction is recorded the moment it is sent, so a recipe that
    // fails halfway still leaves an honest trail of what went out; within a
    // wallet's journal, as part of it (see SignerOptions).
    const recordSent = (sent: KeptTx, within?: Tx) =>
      within ? keepTxs(within, actionId, [sent]) : keepTxsSafely(actionId, [sent]);
    const posting = async <T>(chain: string, post: () => Promise<T>): Promise<T> => {
      // Kept before it goes, or not sent at all: a mark lost would let a cut-off run fail.
      await retried(() => keepTxs(db, actionId, [{ chain }]));
      try {
        return await post();
      } catch (error) {
        if (!(error instanceof MayHaveSent)) await retried(() => dropMark(actionId, { chain }));
        throw error;
      }
    };
    // A card that bought the chain's coin for its fees buys it as its first send needs it, once,
    // and a swap for it leaves the USDC the move itself spends there.
    const { draws } = cashOf(recipe, claimed.input, claimed.details, claimed.amountUsd);
    const wallets = await payingFees(
      claimed,
      (onSent) => signerFor({ actionId, attempt: claimed.attempts, onSent }),
      recordSent,
      draws ? { chain: draws, usdc: parseUnits(claimed.amountUsd, 6) } : null,
    );
    // Read just before a sale, so it is written to whichever thread held what it sold.
    const readAt = Date.now();
    const units = sale ? await heldNow(sale) : null;
    heldBefore = units === null ? null : { units, readAt };
    result = await recipe.execute({
      action: claimed,
      input,
      wallets,
      recordSent,
      posting,
    });
  } catch (error) {
    const kind = failureKind(error);
    if (error instanceof NothingMoved) return markFailed(actionId, plainError(error), kind);
    const unanswered = error instanceof MayHaveSent ? error.sent : undefined;
    return settleStopped(await markStopped(actionId, plainError(error), kind, unanswered));
  }

  try {
    await retried(() =>
      recordResult(claimed, result, heldBefore, (tx) => recordLater(tx, claimed, result.later)),
    );
  } catch (error) {
    console.error(`action ${actionId} moved money but its result wasn't recorded`, error);
    await keepTxsSafely(actionId, result.txs);
    return claimed;
  }
  // Filed under the recipe's venue, which every action a recipe runs carries.
  if (result.statement && claimed.venue)
    await recordOwnFills(claimed.venue, result.statement, actionId);
  try {
    // Money on its way is done only once it lands; the landing job watches for that.
    if (result.run?.lands) return await retried(() => requireAction(actionId));
    return await retried(() => finish(actionId, result.note));
  } catch (error) {
    console.error(`action ${actionId} finished but couldn't be marked done`, error);
    return claimed;
  }
}

/**
 * Nothing of it has started: queued, and nothing sent or kept to send, by this run or one before
 * it that failed (each send is kept before it goes, a wallet's journalled one with it).
 */
const unstarted = (leg: ActionRow): boolean => leg.phase === "queued" && leg.txs.length === 0;

/**
 * The one place a run starts: claims a queued move, with every leg of its plan locked, so no two
 * legs start, or are stopped, at once. A move the owner allowed on a card drawn before cards said
 * all they say now, which didn't show a permission it leaves (leftOutPermission), never runs:
 * while none of its plan has started, the whole card is taken back, so nothing moves for a pick
 * that won't run; once some has, that leg is paused while still queued, its card saying where
 * its cash now is, and the rest run on. Its thread is woken in the same write once that settles every leg, keyed
 * as a run's end tells it (tellSettled), so it hears once. Null when it isn't queued, or wasn't run.
 */
async function startRun(tx: Tx, actionId: string): Promise<ActionRow | null> {
  const [row] = await tx
    .select({ proposalId: actions.proposalId })
    .from(actions)
    .where(eq(actions.id, actionId));
  if (!row) return null;
  // Every leg in one lock, in one order, so two legs starting at once never wait on each other.
  const card = await tx
    .select()
    .from(actions)
    .where(row.proposalId ? eq(actions.proposalId, row.proposalId) : eq(actions.id, actionId))
    .orderBy(actions.id)
    .for("update");
  const leg = card.find(({ id }) => id === actionId);
  let stopped: ActionRow[] = [];
  if (card.every(unstarted) && leftOutPermission(card)) {
    const legs = inArray(
      actions.id,
      card.map(({ id }) => id),
    );
    stopped = await step(tx, "recall", legs, { error: RETRACTED.unshown });
  } else if (leg?.phase === "queued" && leftOutPermission([leg])) {
    // Even one tried again whose first run sent something: what it sent doesn't say it granted
    // what its card left out (a swap first, say), and pausing it moves nothing.
    stopped = await step(tx, "skip", eq(actions.id, actionId), {
      error: pausedSaid(stagedLeg(leg).draws, leg.txs.length > 0),
      failureKind: "unshown",
    });
  }
  if (stopped.length === 0) {
    const [claimed] = await step(tx, "claim", eq(actions.id, actionId));
    return claimed ?? null;
  }
  const [first] = stopped;
  const told = first?.threadId ? await settledOutcome(first, tx) : null;
  if (first?.threadId && told)
    await wakeThread(first.threadId, told.reason.slice(0, 2_000), { key: told.id, tx });
  return null;
}

/**
 * What a paused leg's card says: what stopped it, where the cash it was to spend sits now, which
 * the moves before it may have brought there, and that Auni puts it up again, all within the
 * agent's cut of it (LEG_SAID). Of one an earlier try sent from (a fee coin, a swap), only its
 * record says where that went. Its summary names the amount.
 */
export function pausedSaid(draws: CashPlace | null, triedBefore: boolean): string {
  const place =
    draws && (ledgerAt(draws) ? `${placeName(draws)} account` : `wallet on ${placeName(draws)}`);
  // The moves before it may still be landing it there: a stage starts once patience runs out.
  const where = triedBefore
    ? "An earlier try sent only what its record shows."
    : place
      ? `Its cash is in, or headed to, your ${place}.`
      : "Nothing of it moved.";
  return `Paused before sending: its card didn't show a permission it leaves. ${where} Auni will put it up again.`;
}

export async function actionById(actionId: string): Promise<ActionRow | null> {
  const [row] = await db.select().from(actions).where(eq(actions.id, actionId));
  return row ?? null;
}

export async function actionsForThread(threadId: string): Promise<ActionRow[]> {
  return db
    .select()
    .from(actions)
    .where(eq(actions.threadId, threadId))
    .orderBy(desc(actions.createdAt))
    .limit(200);
}

export async function proposalActions(
  proposalId: string,
  executor: Pick<typeof db, "select"> = db,
): Promise<ActionRow[]> {
  return executor
    .select()
    .from(actions)
    .where(eq(actions.proposalId, proposalId))
    .orderBy(actions.createdAt);
}

/** One action, or every leg of one proposal card. */
type ActionTarget = { readonly actionId: string } | { readonly proposalId: string };

/**
 * The owner's tap: waiting rows go to running (allow) or cancelled (decline).
 * Rows no longer waiting are left alone, so a repeated tap moves nothing.
 * Allowed rows are queued in the same transaction (a proposal's first stage),
 * so an allowed move is never left running with nothing to run it; declined
 * ones wake their thread in it, so the agent always hears of a no.
 */
export async function decideActions(
  target: ActionTarget,
  decision: "allow" | "decline",
): Promise<ActionRow[]> {
  let stale: string[] = [];
  const rows = await db.transaction(async (tx) => {
    // A card that can no longer be allowed as shown is taken back before an Allow, so none is
    // (see retractStale). A Decline is the owner's no, which the agent hears as one, whatever card.
    if (decision === "allow") stale = await retractStale(tx);
    const decided = await step(
      tx,
      decision,
      "actionId" in target
        ? eq(actions.id, target.actionId)
        : eq(actions.proposalId, target.proposalId),
    );
    if (decision === "allow") {
      // An ask is one row, applied as it's allowed: nothing to queue, nothing left running.
      const [ask] = decided.filter((row) => isAsk(row.tool));
      if (ask) return [await applyAsk(tx, ask)];
      if ("proposalId" in target) await startProposal(tx, decided);
      else await queueExecution(tx, decided);
    } else {
      await wakeOnDecline(tx, target, decided);
    }
    return decided;
  });
  // The thread stops needing the owner the moment its last waiting row moves.
  const threadIds = new Set([...stale, ...rows.flatMap((row) => row.threadId ?? [])]);
  await Promise.all([...threadIds].map(publishThread));
  return rows;
}

/** Tells the declined rows' thread, so the agent learns the owner said no. */
async function wakeOnDecline(
  tx: Tx,
  target: ActionTarget,
  declined: readonly ActionRow[],
): Promise<void> {
  const [first] = declined;
  if (!first?.threadId) return;
  const reason =
    "actionId" in target
      ? `The owner declined action ${first.id} (${first.summary}).`
      : `The owner declined proposal ${target.proposalId}: ${declined.map((row) => row.summary).join("; ")}.`.slice(
          0,
          2_000,
        );
  await wakeThread(first.threadId, reason, { tx });
}

/**
 * Actions that share a lane run one after another. Every move of an app whose
 * moves run one at a time (App.oneAtATime) shares the app's id as its lane: a
 * prediction market's relayer takes one transaction per wallet at a time; a
 * perps order sets its market's leverage before it places. Core's own moves
 * name theirs (see Recipe.lane): stock trades on Monad, since each sets an
 * exact allowance and reads what it got from the wallet's balance, which
 * another trade at the same time would upset. Everything else runs in its
 * own lane, its id. An app's id is never another lane's (a uuid, or one with a
 * prefix such as `holding:` or `thread:`).
 */
export function executionLane(row: Pick<ActionRow, "id" | "tool" | "details">): string {
  const recipe = recipeForTool(row.tool);
  if (!recipe) return row.id;
  if (appById(recipe.venue)?.oneAtATime) return recipe.venue;
  return recipe.lane?.(row) ?? row.id;
}

/**
 * The two lanes a move waits its turn in, its job's lanes: no two moves
 * sharing either run at once. `lane` is its venue's (see executionLane).
 * `holding` is the moves of one holding: a sale is written by what the
 * wallet held just before it ran, so no other move of that holding may run in
 * between. It is keyed by what the move sells, else what it's about. A move
 * trading one holding for another, with no venue lane, takes the second as its
 * lane, so it waits on moves of both. The two never share a string, since a
 * lane is its name.
 */
export function executionKeys(
  row: Pick<ActionRow, "id" | "venue" | "tool" | "input" | "details" | "amountUsd">,
): { readonly lane: string; readonly holding: string } {
  const traded = tradedHoldings(row);
  const sold = traded.sale ?? traded.sends[0] ?? null;
  const about = traded.about[0] ?? null;
  const of = (key: FillKey) => `holding:${fillIdentity(key)}`;
  const venue = executionLane(row);
  const second = sold && about && fillIdentity(about) !== fillIdentity(sold) ? of(about) : null;
  const lane = venue !== row.id ? venue : (second ?? row.id);
  const key = sold ?? about;
  return { lane, holding: key ? of(key) : `holding:${row.id}` };
}

/**
 * The holdings a recorded move trades, by what its card showed: the sale it
 * shows, which is written to whichever thread held what it sold (see soldHolding);
 * what a raw transaction sends, by its simulation, which isn't; and what
 * it's about, or what a raw transaction gets. Its lanes take the first of
 * each (see executionKeys).
 */
function tradedHoldings(row: Pick<ActionRow, "tool" | "input" | "details" | "amountUsd">): {
  readonly sale: FillKey | null;
  readonly sends: readonly FillKey[];
  readonly about: readonly FillKey[];
} {
  const recipe = recipeForTool(row.tool);
  const subject = recipe ? subjectOf(recipe, row) : null;
  const raw = RAW_TRANSACTION_TOOLS.includes(row.tool) ? shownHoldings(row).moved : null;
  return {
    sale: soldHolding(row),
    sends: raw?.sends ?? [],
    about: raw
      ? raw.gets
      : subject?.kind === "token"
        ? [tokenKey(subject.chain, subject.mint)]
        : [],
  };
}

/**
 * Queues queued rows to run, each on its own, in the caller's
 * transaction: the change that lets them run and their jobs commit together.
 * Keyed to the row's attempt, so each run of a move is queued once; the
 * claim in executeAction still runs it once.
 */
export async function queueExecution(
  executor: Executor,
  rows: readonly ActionRow[],
  at?: Date,
): Promise<void> {
  for (const row of rows) {
    const { lane, holding } = executionKeys(row);
    await actionKind.enqueue(
      executor,
      { actionId: row.id, lane, holding },
      { key: `action-${row.id}-a${row.attempts}`, ...(at ? { at } : {}) },
    );
  }
}

/**
 * Records the moves `action`'s card showed coming later (ExecuteResult.later), allowed by its
 * tap, each queued to run by itself at its time, in the write that records its run: once, as a
 * write that landed unacknowledged is tried again. Its card already said it, so it is told in no
 * thread and wakes none; Activity shows it once done.
 */
async function recordLater(tx: Tx, action: ActionRow, later: readonly Later[] = []): Promise<void> {
  for (const move of later) {
    const recipe = recipeForTool(move.tool);
    if (!recipe) throw new Error(`No recipe handles ${move.tool}.`);
    const [already] = await tx
      .select({ id: actions.id })
      .from(actions)
      .where(and(eq(actions.tool, recipe.tool), sql`${actions.details}->>'after' = ${action.id}`))
      .limit(1);
    if (already) continue;
    const rows = await tx
      .insert(actions)
      .values({
        summary: move.summary,
        amountUsd: "0",
        ...begins("queued"),
        venue: recipe.venue,
        tool: recipe.tool,
        input: move.input,
        // The move whose card showed it, and whose tap allowed it.
        details: { after: action.id },
        cardFormat: action.cardFormat,
      })
      .returning();
    await queueExecution(tx, rows, move.at);
  }
}

/**
 * Queues a plan's first stage, in the caller's transaction, once it may run
 * (see nextStep); a proposal runs in order, each later stage queued as the
 * one before it settles (see advanceProposal).
 */
export async function startProposal(executor: Executor, rows: readonly ActionRow[]): Promise<void> {
  const step = nextStep(rows.map(stagedLeg));
  if (step.kind === "start")
    await queueExecution(
      executor,
      rows.filter((row) => step.ids.includes(row.id)),
    );
}

/** How much of each leg's error the agent reads when its plan settles: Auni's own words fit whole. */
export const LEG_SAID = 160;

/**
 * What to tell the agent once an action finishes: a lone action reports alone, a
 * proposal's leg only once every leg has settled (one wake for the whole
 * card). Null while it (its result not yet recorded) or other legs are still
 * waiting or running. `id` names the wake, so two legs settling at once wake
 * once, and each run of a step tried again wakes anew.
 */
export async function settledOutcome(
  action: ActionRow,
  executor: Pick<typeof db, "select"> = db,
): Promise<{ readonly reason: string; readonly id: string } | null> {
  if (!SETTLED.includes(action.status)) return null;
  if (!action.proposalId)
    return { reason: actionOutcome(action), id: `action-settled-${action.id}-a${action.attempts}` };
  const legs = await proposalActions(action.proposalId, executor);
  if (!legs.every((leg) => SETTLED.includes(leg.status))) return null;
  // What didn't go through first, which the agent acts on, so a wake cut short cuts only what did.
  const told = [
    ...legs.filter((leg) => leg.status !== "done"),
    ...legs.filter((leg) => leg.status === "done"),
  ];
  return {
    reason: [
      `Every leg of proposal ${action.proposalId} has settled:`,
      ...told.map(
        (leg) => `- ${actionOutcome({ ...leg, error: leg.error?.slice(0, LEG_SAID) ?? null })}`,
      ),
    ].join("\n"),
    id: `proposal-settled-${action.proposalId}-a${cardRuns(legs)}`,
  };
}

/**
 * How many runs a proposal's legs have had between them: Try again adds one
 * to each leg it runs again, so the count goes up with every tap on it.
 */
export function cardRuns(legs: readonly Pick<ActionRow, "attempts">[]): number {
  return legs.reduce((sum, leg) => sum + leg.attempts, 0);
}

function actionOutcome(
  action: Pick<ActionRow, "id" | "summary" | "status" | "error" | "run" | "card">,
): string {
  const detail = action.error ? `: ${action.error}` : "";
  return `Action ${action.id} (${action.summary}) finished as ${action.status}${detail}${doneNote(action)}`;
}

/**
 * What a done move brought back or spent and where its money landed, said so
 * the agent never works a sale's proceeds or a buy's cost out from balances.
 * Money crossing to another network or venue is done once it lands; one that
 * ended some other way says so in its error instead.
 */
function doneNote(action: Pick<ActionRow, "status" | "run" | "error" | "card">): string {
  if (action.status !== "done") return "";
  const { returnedUsd, spentUsd, lands, filled } = action.run;
  return [
    filled ? `. ${filled}` : "",
    returnedUsd ? `. It brought back ${dollars(returnedUsd)}` : "",
    spentUsd ? `. It spent ${dollars(spentUsd)}` : "",
    lands && !action.error ? `. It landed as ${lands}` : "",
    // The fact the agent judges by, whether the owner would want an app asked for (send_feedback).
    action.card?.checks ? `. ${action.card.checks.why}` : "",
  ].join("");
}

/**
 * A run stopped while sending (by a throw, or cut off by a restart), its receipts read once now:
 * a move whose sends already landed or reverted settles at once, a trade among them recorded
 * from what its recipe reads back; one nothing can ever read is held for the owner at once; and
 * one that can't be read yet stays unsure for reconcile, which looks at a move once it is
 * STUCK_AFTER_MS old.
 */
export async function settleStopped(stopped: ActionRow): Promise<ActionRow> {
  // Only a move unsure of what it sent; one landing, settled, or left as it was is as it stands.
  if (stopped.phase !== "unsure") return stopped;
  try {
    return (await settleFromReceipts(stopped, true)) ?? (await requireAction(stopped.id));
  } catch (error) {
    console.error(`action ${stopped.id}: receipts unreadable, reconcile will settle it`, error);
    return stopped;
  }
}

/** The row as the web card and the agent see it. */
export function actionWire(row: ActionRow): z.input<typeof actionWireSchema> {
  return {
    id: row.id,
    threadId: row.threadId,
    proposalId: row.proposalId,
    status: row.status,
    phase: row.phase,
    tool: row.tool,
    venue: row.venue,
    summary: row.summary,
    amountUsd: row.amountUsd,
    lines: row.lines,
    details: row.details,
    run: row.run as Record<string, string>,
    input: row.input,
    // A send still waiting on its hash has nothing to link to yet.
    txs: row.txs.flatMap(({ chain, hash, setup, buysFees }) =>
      hash ? [{ chain, hash, ...(setup ? { setup } : {}), ...(buysFees ? { buysFees } : {}) }] : [],
    ),
    error: row.error,
    failureKind: row.failureKind,
    attempts: row.attempts,
    retryable: retryRefusal(row) === null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Why a move failed, as its row keeps it for the agent, its card and a channel: on one line,
 * with no link or secret the error quoted (safe-words.ts).
 */
function plainError(error: unknown): string {
  return errorWords(error).replace(/\s+/gu, " ").trim().slice(0, 500) || "The action failed.";
}
