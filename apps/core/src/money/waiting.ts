import { ASK_TOOL_NAMES, CARD_FORMAT, CARD_WAITS_MS } from "@auni/shared";
import { and, asc, eq, inArray, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { result, type AuniTool } from "../agent/tool.ts";
import { publishThread } from "../conversation/threads.ts";
import { db, type Tx } from "../db/client.ts";
import { actions, messages, threads, type ActionRow } from "../db/schema.ts";
import { wakeThread } from "../jobs/kinds.ts";
import { retract, step } from "./life.ts";

// Cards still waiting for the owner's tap, and the three ways one stops waiting untapped: a newer
// card takes its place, the agent takes it back, or it waits a day. A card is one move, or every
// leg of one proposal, and is named by its id: the proposal's, else the move's.

/** Still waiting for the owner's tap. */
const waitingNow = eq(actions.status, "awaiting_permission");

/**
 * Whether the owner's chat holds this move's card (its plan's, for a leg): kept in a message, or
 * on the answer its turn is still giving. A move an Auto turn began just before it was cut off
 * can have none, and the owner never saw it.
 */
export async function cardReached(
  action: Pick<ActionRow, "id" | "threadId" | "proposalId">,
  tx: Pick<typeof db, "select"> = db,
): Promise<boolean> {
  if (!action.threadId) return false;
  const card = action.proposalId
    ? { proposalId: action.proposalId }
    : { actionReference: action.id };
  const holds = JSON.stringify([{ type: "data-cards", data: { cards: [card] } }]);
  const [kept] = await tx
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.threadId, action.threadId), sql`${messages.parts} @> ${holds}::jsonb`))
    .limit(1);
  if (kept) return true;
  const [giving] = await tx
    .select({ id: threads.id })
    .from(threads)
    .where(
      and(
        eq(threads.id, action.threadId),
        sql`${threads.answerSoFar} -> 'parts' @> ${holds}::jsonb`,
      ),
    );
  return Boolean(giving);
}

/** A waiting card as the agent reads it: its id, and what it asks. */
export interface WaitingCard {
  readonly id: string;
  readonly asks: string;
}

/** Each card among `rows`, by its id, with what it asks: its move, or its moves in turn. */
export function cardsOf(rows: readonly ActionRow[]): WaitingCard[] {
  const cards = new Map<string, string[]>();
  for (const row of rows.toSorted((a, b) => a.seq - b.seq)) {
    const id = row.proposalId ?? row.id;
    cards.set(id, [...(cards.get(id) ?? []), row.summary]);
  }
  return [...cards].map(([id, summaries]) => ({ id, asks: summaries.join("; ") }));
}

/** Every move of the cards `ids` names, by a card's id: its proposal's, or its own. */
const cardIn = (ids: readonly string[]): SQL | undefined =>
  ids.length > 0
    ? or(inArray(actions.id, [...ids]), inArray(actions.proposalId, [...ids]))
    : undefined;

const listed = (cards: readonly WaitingCard[]) =>
  cards.map((card) => `- card ${card.id}: ${card.asks}`).join("\n");

/** What every money tool takes to say which waiting cards of its thread the new one stands in for. */
export const replacesInput = z
  .array(z.uuid())
  .max(20)
  .optional()
  .describe(
    "The cards still waiting for the owner's tap in this conversation that this one takes the place of, by card id: they come off the table as this one is recorded. [] keeps them all waiting beside it. Required while any wait here; your context lists them.",
  );

/**
 * Takes the place of the waiting cards a new card stands in for, in the transaction that records
 * it: those of its thread the agent named in `replaces`, and `alsoReplaced` (a specialist's older
 * plan, wherever it waits). While its thread has money cards waiting, the agent must say which
 * it replaces, if any, so a card that stands in for others never leaves them to be tapped, and one
 * meant beside them never takes them away; a name that is no card waiting there is refused. An
 * ask (starting a specialist, say) is never a money card's to replace. Throws, recording nothing,
 * with words for the agent.
 */
export async function replaceCards(
  tx: Tx,
  threadId: string | null,
  replaces: readonly string[] | undefined,
  alsoReplaced: SQL | undefined,
): Promise<WaitingCard[]> {
  const also = alsoReplaced
    ? await tx.select().from(actions).where(and(waitingNow, alsoReplaced))
    : [];
  const here = threadId
    ? cardsOf(
        (
          await tx
            .select()
            .from(actions)
            .where(
              and(
                waitingNow,
                eq(actions.threadId, threadId),
                notInArray(actions.tool, [...ASK_TOOL_NAMES]),
              ),
            )
            .orderBy(asc(actions.seq))
        ).filter((row) => !also.some(({ id }) => id === row.id)),
      )
    : [];
  if (here.length > 0 && replaces === undefined)
    throw new Error(
      "Nothing was recorded, and the owner saw nothing: these cards still wait for the owner's tap in this conversation. " +
        "Call again with `replaces`: the ids of the ones this card takes the place of, or [] to leave them all waiting beside it.\n" +
        listed(here),
    );
  const unknown = (replaces ?? []).filter((id) => !here.some((card) => card.id === id));
  if (unknown.length > 0)
    throw new Error(
      `Nothing was recorded, and the owner saw nothing: no card waiting in this conversation has the id ${unknown.join(", ")}. ` +
        (here.length > 0 ? `The cards waiting here are:\n${listed(here)}` : "None waits here."),
    );
  const named = here.filter((card) => replaces?.includes(card.id));
  const replaced = await step(tx, "replace", or(cardIn(named.map(({ id }) => id)), alsoReplaced));
  return cardsOf(replaced);
}

/** Tells the agent which of its earlier cards the new one replaced, so its words can say so. */
export function replacedNote(replaced: readonly WaitingCard[]): string | null {
  if (replaced.length === 0) return null;
  return `It replaces, and takes off the table: ${replaced.map((card) => `"${card.asks}" (card ${card.id})`).join(", ")}.`;
}

/**
 * Takes back every card that can no longer be allowed as it was shown, as Auni starts, as a cron
 * runs and before any Allow, in that tap's transaction. One that has waited a day for the owner's
 * tap (CARD_WAITS_MS): its prices and the agent's reasons for it are a day old, so it says so and
 * the owner asks again; its thread isn't woken, since nothing happened there. And a money card
 * drawn before cards said all they say now (CARD_FORMAT), which Allow would refuse: it says it is
 * out of date, and its thread is woken, so the agent puts the move up again if it still fits. Either way its
 * sealed card is left as it was shown. In one transaction, so no card is taken back without the
 * wake that tells its thread. Returns the threads whose cards it took back.
 */
export async function retractStale(tx: Tx): Promise<string[]> {
  const stale = await retract(
    tx,
    lt(actions.createdAt, sql`now() - make_interval(secs => ${CARD_WAITS_MS / 1_000})`),
    "stale",
  );
  const drawnBefore = and(
    lt(actions.cardFormat, CARD_FORMAT),
    notInArray(actions.tool, [...ASK_TOOL_NAMES]),
  );
  // The whole card: every leg of a plan with any such leg, so none is left to be allowed alone.
  const old = await retract(
    tx,
    or(
      drawnBefore,
      inArray(
        actions.proposalId,
        tx.select({ id: actions.proposalId }).from(actions).where(and(waitingNow, drawnBefore)),
      ),
    ),
    "outOfDate",
  );
  for (const [threadId, cards] of byThread(old))
    await wakeThread(
      threadId,
      // Every card's id before what any asked, which a wake may cut short.
      `Auni updated, and its cards now say more about each move, so it took back the cards still waiting here from before, which the owner can no longer allow: ${cards.map((card) => `card ${card.id}`).join(", ")}. Nothing moved, and each can be put up again as a fresh card. They asked: ${cards.map((card) => `"${card.asks}" (card ${card.id})`).join(", ")}.`,
      { tx },
    );
  return [...new Set([...stale, ...old].flatMap((row) => row.threadId ?? []))];
}

/** Takes back every card that can no longer be allowed as shown (retractStale), and tells their threads' open tabs. */
export async function takeBackStale(): Promise<void> {
  for (const threadId of await db.transaction(retractStale)) await publishThread(threadId);
}

/** Each thread's cards among `rows`. */
function byThread(rows: readonly ActionRow[]): Map<string, WaitingCard[]> {
  const threads = new Map<string, ActionRow[]>();
  for (const row of rows)
    if (row.threadId) threads.set(row.threadId, [...(threads.get(row.threadId) ?? []), row]);
  return new Map([...threads].map(([threadId, here]) => [threadId, cardsOf(here)]));
}

/**
 * The agent's way to take back a card it no longer stands behind, in any conversation, rather
 * than asking the owner to decline it. Nothing moves; the card says Auni took it back.
 */
export function retractCardsTool(): AuniTool {
  return {
    name: "retract_cards",
    description:
      "Take back cards still waiting for the owner's tap that you no longer stand behind: a later move made one pointless, the owner changed their mind, or it waits in another conversation and no longer fits. Use this, never ask the owner to decline a card. Nothing moves; each card says Auni took it back, so say why in your reply. Your context lists the cards waiting, here and elsewhere, by card id. To put a new card in one's place in this conversation, pass `replaces` to the money tool instead.",
    inputSchema: {
      cards: z.array(z.uuid()).min(1).max(20).describe("The ids of the cards to take back."),
    },
    async handler(input) {
      const ids = input.cards as string[];
      // One conditional write: a tap that landed first leaves its card allowed, and this skips it.
      const taken = await retract(db, cardIn(ids), "agent");
      const threads = new Set(taken.flatMap((row) => row.threadId ?? []));
      await Promise.all([...threads].map(publishThread));
      const cards = cardsOf(taken);
      const left = ids.filter((id) => !cards.some((card) => card.id === id));
      return result(
        [
          cards.length > 0
            ? `Taken back: ${cards.map((card) => `"${card.asks}" (card ${card.id})`).join(", ")}. Each now says Auni took it back.`
            : "Nothing was taken back.",
          left.length > 0
            ? `${left.join(", ")} ${left.length === 1 ? "is" : "are"} no card still waiting: allowed, declined or ended already, or never one.`
            : null,
        ]
          .filter(Boolean)
          .join(" "),
        { retracted: cards.map((card) => card.id) },
      );
    },
  };
}
