import { HELD, RAW_TRANSACTION_TOOLS, type HeldWhy } from "@auni/shared";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { TransactionReceiptNotFoundError, type Address, type Hash } from "viem";

import { publishThread } from "../conversation/threads.ts";
import { db } from "../db/client.ts";
import { actions, fills, threads, type ActionRow } from "../db/schema.ts";
import { wakeThread } from "../jobs/kinds.ts";
import { accountOf, ledgerAt, appById, theWallet } from "../apps/registry.ts";
import { showedAssetsMoving } from "./approved.ts";
import { chainIdOf, evmClient, solanaRpc } from "./chains.ts";
import { STUCK_AFTER_MS } from "./readings.ts";
import type { KeptTx, ReadBack } from "./recipe.ts";
import { recipeForTool } from "./recipes/index.ts";
import { recordStatement } from "./statements.ts";
import { evmSwap } from "./swaps/evm-swap.ts";
import { noted, step } from "./life.ts";
import {
  finish,
  keepTxsSafely,
  markFailed,
  recordResult,
  retried,
  settleLanding,
} from "./record.ts";
import { cardReached } from "./waiting.ts";
import { walletAddresses } from "./wallets.ts";

/** Long past any chain's settling, so a send still unconfirmed this long is held for the owner. */
const OVERDUE_AFTER_MS = 24 * 60 * 60_000;

export type Receipt = "confirmed" | "reverted" | "pending";

/**
 * Settles moves still running long after they started: ones whose money moved but whose
 * result was never marked, and held ones, read again in case the world now answers. Returns
 * the ones it finished or failed. Newest first, so rows that will never settle can't crowd out
 * ones that will.
 */
export async function reconcileStuckActions(): Promise<ActionRow[]> {
  const stuck = await db
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.status, "running"),
        lt(actions.startedAt, sql`now() - make_interval(secs => ${STUCK_AFTER_MS / 1000})`),
      ),
    )
    .orderBy(desc(actions.startedAt), desc(actions.seq))
    .limit(100);
  const settled: ActionRow[] = [];
  for (const action of stuck) {
    try {
      // Money on its way whose watch stopped is checked as the watch would have.
      const row =
        action.phase === "landing"
          ? await settleLanding(action.id)
          : await settleFromReceipts(action);
      if (row?.status === "done" || row?.status === "failed") settled.push(row);
    } catch (error) {
      console.error(`reconciling action ${action.id} failed`, error);
    }
  }
  return settled;
}

/**
 * Up to 50 held moves, each waiting on the owner's Check again or Close (see hold), with what
 * its card was for, why it is held, and the chat its card is in (none for one started outside a
 * chat, or whose chat was deleted), the oldest first.
 */
export async function heldMoves(): Promise<
  {
    id: string;
    summary: string;
    why: HeldWhy | undefined;
    chat: { id: string; title: string | null } | null;
  }[]
> {
  const rows = await db
    .select({
      id: actions.id,
      summary: actions.summary,
      run: actions.run,
      threadId: threads.id,
      title: threads.title,
    })
    .from(actions)
    .leftJoin(threads, eq(threads.id, actions.threadId))
    .where(eq(actions.phase, "needs_owner"))
    .orderBy(asc(actions.seq))
    .limit(50);
  return rows.map(({ id, summary, run, threadId, title }) => ({
    id,
    summary,
    why: run.held,
    chat: threadId === null ? null : { id: threadId, title },
  }));
}

/** What an action's transactions say about it, read in the order they were sent. */
type Settlement = "pending" | "set-up-only" | "reverted" | "partway" | "done" | "unrecorded";

/**
 * Any transaction still pending waits, and so does an action with none.
 * Only setup steps, or every move reverted, mean nothing moved. Any move that
 * landed moved money: a move that records no fills (a withdrawal, a plain
 * bridge, a deposit) is done, or done partway when a later move reverted
 * (a move sent in more than one transaction); a trade stays unrecorded, still
 * holding its specialist's money, since its fills are the only record of
 * what it bought or sold.
 */
export function settlement(
  sent: readonly { readonly receipt: Receipt; readonly setup: boolean }[],
  trades: boolean,
): Settlement {
  if (sent.length === 0 || sent.some((tx) => tx.receipt === "pending")) return "pending";
  // An approval or funding step isn't the move: only the move itself landing finishes it.
  const moves = sent.filter((tx) => !tx.setup);
  if (moves.length === 0) return "set-up-only";
  if (moves.every((tx) => tx.receipt === "reverted")) return "reverted";
  if (trades) return "unrecorded";
  return moves.at(-1)?.receipt === "reverted" ? "partway" : "done";
}

/**
 * Settles one running action from what it recorded; null while it can't yet.
 * Recorded fills mean it traded, so it is done, still saying what stopped it
 * (an order that filled after its stops were refused); one that sends
 * nothing and recorded none moved nothing; otherwise its transactions decide
 * (see `settlement`). A trade whose sends confirmed is settled by what its recipe
 * reads back from their receipts, and a send that never got an answer only by its
 * venue's statement (see settleFromReadBack).
 * What nothing can settle is held for the owner (see hold). `patient` is the
 * first read, moments after a run stopped: a read back that can't answer yet
 * is waited on then, and held only by a later read.
 */
export async function settleFromReceipts(
  action: ActionRow,
  patient = false,
): Promise<ActionRow | null> {
  const [recorded] = await db
    .select({ id: fills.id })
    .from(fills)
    .where(eq(fills.actionId, action.id))
    .limit(1);
  // What stopped its run; the words a held move carries instead say only why it was held.
  const said = action.run.held ? null : action.error;
  if (recorded) return finish(action.id, said ?? undefined);
  if (recipeForTool(action.tool)?.offChain)
    return markFailed(
      action.id,
      said ?? "It stopped before anything moved.",
      action.failureKind ?? "unknown",
    );
  const kept = deciding(action.txs);
  const sent = await Promise.all(
    kept.map(async (tx) => ({
      receipt: await sentReceipt(action, tx),
      setup: tx.setup === true,
    })),
  );
  switch (settlement(sent, trades(action))) {
    case "pending":
      // A send kept with nothing to read never answers by itself: only its venue's record can.
      if (kept.some((tx) => !tx.hash && !tx.walletTxId && !tx.relayerId))
        return settleFromReadBack(action, "unanswered", patient);
      return Date.now() - (action.startedAt?.getTime() ?? Date.now()) > OVERDUE_AFTER_MS
        ? hold(action, "overdue")
        : null;
    case "set-up-only":
      return markFailed(
        action.id,
        said ?? "It stopped after setting up, before the move.",
        action.failureKind ?? "unknown",
      );
    case "reverted":
      return markFailed(
        action.id,
        said ?? "Its transactions didn't go through, so nothing moved.",
        "sent",
      );
    case "partway":
      return finish(action.id, `Only part of it went through. ${said ?? ""}`.trim());
    case "done":
      return finish(action.id);
    case "unrecorded":
      return settleFromReadBack(action, "unrecorded", patient);
  }
}

/**
 * Settles a stopped move by what can be read back of it, for one of two reasons (`why`): its
 * sends confirmed and it is a trade, or a send of it never got an answer. Its recipe reads its
 * fills back (see Recipe.readBack), which are recorded as its run would have recorded them, and
 * it is done, noted as read back; or its venue's statement shows them, which records them
 * itself. A reader's word that nothing moved fails it. With nothing to read it back, or once a
 * read that isn't the first still can't tell, it is held for the owner.
 */
async function settleFromReadBack(
  action: ActionRow,
  why: HeldWhy,
  patient: boolean,
): Promise<ActionRow | null> {
  const read = readerOf(action, why);
  if (!read) return hold(action, why);
  const back = await read().catch((error: unknown) => {
    console.warn(`action ${action.id}: what it did couldn't be read back`, error);
    return null;
  });
  if (back === null) return patient ? null : hold(action, why);
  if (back === "nothing moved")
    return markFailed(
      action.id,
      "It never went through, so nothing moved.",
      action.failureKind ?? "unknown",
    );
  if (back !== "recorded")
    await retried(() =>
      recordResult(action, { txs: [], fills: back.fills, run: { settledBy: "read back" } }),
    );
  return finish(action.id, back === "recorded" ? undefined : back.note);
}

/**
 * What can read a stopped move back: for one whose sends all confirmed, its recipe's own reader,
 * which reads their receipts; else the statement of a venue that keeps one, read on now, which
 * records the move's fills itself once it shows them ("recorded"). A send that never got an
 * answer has no receipt, so a recipe's reader would read only the sends around it and take them
 * for the whole move (a swap's set-up for a trade that moved nothing): only a venue's own record
 * can speak for it. Undefined for a move nothing reads back.
 */
function readerOf(
  action: ActionRow,
  why: HeldWhy,
): (() => Promise<ReadBack | "recorded" | null>) | undefined {
  const recipe = recipeForTool(action.tool);
  if (why === "unrecorded" && recipe?.readBack) {
    const { readBack } = recipe;
    return async () => {
      const { evm, solana } = await walletAddresses();
      return readBack({
        action,
        input: action.input as never,
        evmAddress: evm,
        solanaAddress: solana,
      });
    };
  }
  const { venue } = action;
  const statement = venue ? accountOf(venue)?.account.statement : undefined;
  if (!venue || !statement) return undefined;
  return async () => {
    const { evm } = await walletAddresses();
    if (!evm) return null;
    await recordStatement(venue, statement(evm as Address));
    const [shown] = await db
      .select({ id: fills.id })
      .from(fills)
      .where(eq(fills.actionId, action.id))
      .limit(1);
    return shown ? "recorded" : null;
  };
}

/**
 * Holds a move nothing Auni can read will settle (the `hold` step of its life), saying why
 * (see HELD), and wakes its thread in the same write, so the agent tells the owner once: a
 * move already held takes no step, so it wakes no one again. Its card then offers Check again
 * and Close (money/held.ts), and reconcile keeps reading it. Returns null: it hasn't settled.
 */
async function hold(action: ActionRow, why: HeldWhy): Promise<null> {
  const held = await db.transaction(async (tx) => {
    const [row] = await step(tx, "hold", eq(actions.id, action.id), {
      error: HELD[why],
      run: noted({ held: why }),
    });
    if (row?.threadId)
      await wakeThread(
        row.threadId,
        heldReason(row, why, action.error, await cardReached(row, tx)),
        {
          key: `action-held-${row.id}-a${row.attempts}`,
          tx,
        },
      );
    return row;
  });
  if (!held) return null;
  console.warn(`Action ${held.id} (${held.tool}) is held for the owner: ${why}`);
  // The thread's row says it needs the owner (see waitingOnOwner in conversation/threads.ts).
  if (held.threadId) await publishThread(held.threadId);
  return null;
}

/** What the agent is told of a move just held: what is known, what isn't, and what not to do. */
function heldReason(
  held: ActionRow,
  why: HeldWhy,
  stoppedWith: string | null,
  shown: boolean,
): string {
  const hashes = held.txs.flatMap((tx) => (tx.hash ? [`${tx.hash} on ${tx.chain}`] : []));
  return [
    `Action ${held.id} (${held.summary}) is held. ${HELD[why]}`,
    hashes.length > 0 ? `Its transactions: ${hashes.join(", ")}.` : "It kept no transaction hash.",
    stoppedWith ? `Its run stopped with: ${stoppedWith.slice(0, 300)}` : "",
    "Auni will not send it again, and keeps reading by itself in case the answer comes. " +
      (shown
        ? "Its card now says this to the owner, with Check status and Dismiss card. "
        : "No card for it reached the owner's chat, so they haven't seen it. ") +
      "Tell them once, calmly: " +
      "what happened, that nothing else is at risk, and where to look (the transaction on its " +
      "chain, or the service's own site). Look up what you can first (get_portfolio, " +
      "read_chain, the service's own tools). Don't propose this move again while it is held: " +
      "if it did go through, a second one would double it.",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * The sends whose receipts decide an action: all of them, except a copy that
 * a hashed one speaks for. A send kept by its wallet's id is spoken for by the
 * last hash kept for that id: the one its hash came back as, or the one that
 * replaced it at a higher fee (a stuck send, local-key/evm.ts). One kept by its
 * relayer id is spoken for once its hash came back. One kept with nothing to
 * read is unknown, so it holds the action for a person, until a move sent after
 * it answers for it: an order the venue took, once it named the trades it made, or a batch
 * a venue's relayer took, once it named its id for it.
 * Nothing sent before it can, so a send that got no answer is never settled by
 * what landed earlier.
 */
export function deciding(txs: readonly KeptTx[]): KeptTx[] {
  return txs.filter((tx, index) => {
    if (tx.walletTxId)
      return (
        (txs.findLast((other) => other.hash && other.walletTxId === tx.walletTxId) ?? tx) === tx
      );
    if (tx.hash) return true;
    if (tx.relayerId) return !txs.some((other) => other.hash && other.relayerId === tx.relayerId);
    return !txs.slice(index + 1).some((later) => (later.hash || later.relayerId) && !later.setup);
  });
}

/**
 * A send's receipt by its hash. One with no hash yet is read through whoever
 * took it, the wallet or the action's venue's relayer (see App.relayed), and
 * its hash kept once they have one. One the chain doesn't know yet is asked of
 * the wallet that sent it too, which can send it again or say it will never land.
 */
async function sentReceipt(
  { id: actionId, venue }: Pick<ActionRow, "id" | "venue">,
  tx: KeptTx,
): Promise<Receipt> {
  const read = tx.hash ? await receipt(tx.chain, tx.hash) : "pending";
  if (read !== "pending") return read;
  if (tx.relayerId && !tx.hash) {
    const relayed = venue ? appById(venue)?.relayed : undefined;
    if (!relayed) return "pending";
    const found = await relayed(tx.relayerId);
    if (found === "pending") return "pending";
    if (found === "failed") return "reverted";
    await keepTxsSafely(actionId, [{ ...tx, hash: found.hash }]);
    return receipt(tx.chain, found.hash);
  }
  // Taken off chain with nothing to read, or never answered (see MayHaveSent): it waits for a person.
  if (!tx.walletTxId) return "pending";
  const found = await theWallet().sendStatus(tx.walletTxId);
  if (found === "pending") return "pending";
  if (found === "failed") return "reverted";
  if (found.hash === tx.hash) return "pending";
  await keepTxsSafely(actionId, [{ ...tx, hash: found.hash }]);
  return receipt(tx.chain, found.hash);
}

/** A buy, a sell, or a swap of one holding for another: a move whose outcome is its fills. */
function trades(action: ActionRow): boolean {
  // A token-for-token swap has no direction (it always asks) but records fills.
  if (action.tool === evmSwap.tool) return true;
  // A raw transaction whose card showed assets moving records them as fills.
  if (RAW_TRANSACTION_TOOLS.includes(action.tool)) return showedAssetsMoving(action);
  return (recipeForTool(action.tool)?.direction?.(action.input) ?? null) !== null;
}

async function receipt(chain: string, hash: string): Promise<Receipt> {
  if (chain === "solana") {
    const { value } = await solanaRpc<{
      value: ({ err: unknown; confirmationStatus: string | null } | null)[];
    }>("getSignatureStatuses", [[hash], { searchTransactionHistory: true }]);
    const status = value[0];
    if (!status) return "pending";
    if (status.err) return "reverted";
    return status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized"
      ? "confirmed"
      : "pending";
  }
  // A ledger of an app's own (see ledgerAt) has no receipts, and a send there is kept only once
  // the recipe returned, so the app accepted it. Only a ledger: every chain is read below, so
  // a send that reverted on one is never taken for done.
  if (ledgerAt(chain)) return "confirmed";
  try {
    const found = await evmClient(chainIdOf(chain)).getTransactionReceipt({ hash: hash as Hash });
    return found.status === "success" ? "confirmed" : "reverted";
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) return "pending";
    throw error;
  }
}
