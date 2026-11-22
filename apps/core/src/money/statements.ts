import { setTimeout as sleep } from "node:timers/promises";

import { appListing } from "@auni/shared";
import { eq, inArray, sql } from "drizzle-orm";
import type { Address } from "viem";

import { db, type Tx } from "../db/client.ts";
import { actions, arrivalCursors, fills, type ActionRow } from "../db/schema.ts";
import { accounts } from "../apps/registry.ts";
import { fillIdentity, QUANTITY_DECIMALS } from "./fill-key.ts";
import { perpFace } from "./holdings.ts";
import { showPosted, tellStatement, type Posted, type StatementNews } from "./news.ts";
import { addToBooks, allFills, holdersOf } from "./books.ts";
import { saleOwners, sharedFill } from "./books.ts";
import { begins } from "./life.ts";
import { insertFills } from "./record.ts";
import { parseUnits } from "./usd.ts";
import type { AppSweep } from "./sweep.ts";
import type { Happened, Statement, StatementEntry, StatementFill } from "./venue-statement.ts";

/**
 * A venue's statement: the account's own record of what traded in it, as the
 * venue keeps it. Auni reads it on from where it last stopped and writes each
 * line once, asking of each one question: did Auni do this? A line an order
 * of Auni's made, known by the tag Auni put on the order before sending it,
 * is that action's, however late it fills (a stop, a resting limit). Any
 * other is something the venue or someone else did (a liquidation,
 * auto-deleveraging, a trade in the venue's own app), recorded as a done
 * action of its own under the venue's tool (see VENUE_TOOL_NAMES). Either way
 * the closing rule (see lineOwners) says whose it is, and what no move was
 * just doing is told to the person (see tellStatement). What anything is
 * worth still comes from live reads: a statement says only who owns what,
 * and what happened.
 *
 * A venue adds its statement by reading it into entries (see Statement in
 * venue-statement.ts); recording them is the same for all.
 */

/**
 * How long a read of a statement stands. A read of one perps venue's weighs 20 of the 1,200 a
 * minute it gives one IP, which its orders share, and a move reads it as it trades (see recordOwnFills),
 * so a sweep soon after asks nothing.
 */
const READ_STANDS_MS = 10 * 60_000;

/**
 * Whether the statement of `venue` (an app id) is due a read: money has moved there through
 * Auni, and it hasn't been read in the last 10 minutes. Otherwise nothing is asked of the venue.
 */
export async function statementDue(venue: string): Promise<boolean> {
  const [moved] = await db
    .select({ id: actions.id })
    .from(actions)
    .where(eq(actions.venue, venue))
    .limit(1);
  if (!moved) return false;
  const [cursor] = await db
    .select({ block: arrivalCursors.block })
    .from(arrivalCursors)
    .where(eq(arrivalCursors.chain, venue));
  return !cursor || cursor.block < Date.now() - READ_STANDS_MS;
}

/**
 * Each perps venue's statement of the owner's EVM wallet, read on when it is due (see
 * statementDue), as the sweep and the hourly statements job run them. `owner` is asked only once
 * one is due, so a run with nothing due never asks the wallet (and so never makes keys); with no
 * EVM wallet, nothing is read.
 */
export function statementSweeps(owner: () => Promise<string | null>): readonly AppSweep[] {
  return accounts().flatMap(({ about, account }) =>
    account.statement
      ? [
          {
            app: about,
            work: "reading its statement",
            async run() {
              if (!(await statementDue(about.id))) return;
              const evm = await owner();
              if (evm) await recordStatement(about.id, account.statement!(evm as Address));
            },
          },
        ]
      : [],
  );
}

/**
 * Reads the owner's statement at `venue` (its app id, which actions and the
 * cursor are kept under) on from where it stopped, and records each line not
 * yet recorded. Safe to run anywhere, as often as wanted: a line recorded once
 * is passed by, and the cursor never goes back. Throws when the venue can't be
 * read, for the next run to try again.
 */
export async function recordStatement(venue: string, statement: Statement): Promise<void> {
  const [cursor] = await db
    .select({ through: arrivalCursors.block })
    .from(arrivalCursors)
    .where(eq(arrivalCursors.chain, venue));
  const { entries, through } = await statement.read(cursor?.through ?? null);
  if (entries.length > 0) {
    await showPosted(await recordEntries(venue, statement, entries));
  }
  await db
    .insert(arrivalCursors)
    .values({ chain: venue, block: through })
    .onConflictDoUpdate({
      target: arrivalCursors.chain,
      set: { block: sql`greatest(${arrivalCursors.block}, ${through})` },
    });
}

/**
 * Whether a fill of a move's orders came after its run ended: a stop firing or a limit left
 * resting filling, which is news. What filled before, its run recorded and its own card tells.
 * A move still running has not ended, so nothing it fills yet is late.
 */
export function filledLater(move: Pick<ActionRow, "endedAt">, at: Date): boolean {
  return move.endedAt !== null && at.getTime() > move.endedAt.getTime();
}

/** How long a move that traded waits for the statement to show it, a read after each wait. */
const OWN_FILLS_WAITS_MS = [0, 500, 1_000, 2_000, 4_000];

/**
 * Records what a move just traded from the statement, the one place its fills
 * are written, read again for a few seconds until it shows them. Never
 * throws: what the statement doesn't show yet, or couldn't be read, is
 * recorded by its next read (see sweepArrivals and the hourly statements run).
 */
export async function recordOwnFills(
  venue: string,
  statement: Statement,
  actionId: string,
): Promise<void> {
  try {
    for (const wait of OWN_FILLS_WAITS_MS) {
      await sleep(wait);
      await recordStatement(venue, statement);
      const [recorded] = await db
        .select({ id: fills.id })
        .from(fills)
        .where(eq(fills.actionId, actionId))
        .limit(1);
      if (recorded) return;
    }
    console.warn(`action ${actionId}: ${venue} doesn't show its fills yet`);
  } catch (error) {
    console.error(`action ${actionId}: ${venue} statement unreadable`, error);
  }
}

/**
 * Writes the entries' lines not yet recorded, each owned by the closing rule
 * against the books as every line before it left them, and tells the person
 * what they didn't just ask for (see tellStatement), in the same transaction,
 * so nothing is told twice and a failure to tell records nothing. Statements
 * are written one at a time, so two reads at once write each line once.
 * Returns what it told.
 */
async function recordEntries(
  venue: string,
  statement: Statement,
  entries: readonly StatementEntry[],
): Promise<Posted[]> {
  const markets = [...new Set(entries.map((entry) => entry.happened.market))];
  const faces = new Map(
    await Promise.all(
      markets.map(async (market) => [market, await perpFace(venue, market)] as const),
    ),
  );
  const venueName = appListing(venue)?.name ?? venue;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('auni:statement'))`);
    const recorded = await recordedLines(
      tx,
      entries.flatMap((entry) => entry.fills.map((fill) => fill.ref)),
    );
    const fresh = entries
      .map((entry) => ({
        ...entry,
        fills: entry.fills.filter((fill) => !recorded.has(fill.ref)),
        // What a read before recorded part of was told then.
        told: entry.fills.some((fill) => recorded.has(fill.ref)),
      }))
      .filter((entry) => entry.fills.length > 0);
    if (fresh.length === 0) return [];
    // Books as each line found them: every fill recorded before it, so a line read late (a
    // first read's history) is owned by who held it then, not by trades made since.
    const recordedFills = await allFills(tx);
    const books = new Map<string, Map<string, bigint>>();
    let added = 0;
    const booksAt = (at: Date) => {
      for (; added < recordedFills.length && recordedFills[added]!.createdAt <= at; added += 1)
        addToBooks(books, recordedFills[added]!);
      return books;
    };
    fresh.sort((a, b) => a.fills[0]!.at.getTime() - b.fills[0]!.at.getTime());
    const tagged = fresh.flatMap((entry) => ("actionId" in entry ? [entry.actionId] : []));
    const actionsOf = new Map(
      tagged.length === 0
        ? []
        : (
            await tx
              .select({
                id: actions.id,
                specialistId: actions.specialistId,
                threadId: actions.threadId,
                endedAt: actions.endedAt,
              })
              .from(actions)
              .where(inArray(actions.id, tagged))
          ).map((row) => [row.id, row]),
    );
    const news: StatementNews[] = [];
    for (const entry of fresh) {
      const actionId =
        "actionId" in entry
          ? entry.actionId
          : await insertOutside(tx, venue, statement.tool, entry, entry.fills[0]!.at);
      const action = actionsOf.get(actionId);
      const owned = entry.fills.flatMap((fill) => {
        const at = booksAt(fill.at);
        const parts = sharedFill(fill, lineOwners(fill, at, action?.specialistId ?? null));
        for (const part of parts) addToBooks(at, part);
        return parts;
      });
      await insertFills(tx, actionId, owned);
      // So a reading taken before it isn't kept standing (see readStands).
      if (action)
        await tx
          .update(actions)
          .set({ updatedAt: sql`now()` })
          .where(eq(actions.id, actionId));
      // A move is told by its own card; an order of Auni's filling after it ended is news, as
      // is anything no order of Auni's did.
      if (!entry.told && (!action || filledLater(action, entry.fills[0]!.at)))
        news.push({
          actionId,
          threadId: action?.threadId ?? null,
          happened: entry.happened,
          ...("exit" in entry && entry.exit ? { exit: entry.exit } : {}),
          ...("unfinished" in entry && entry.unfinished ? { unfinished: entry.unfinished } : {}),
          venue: venueName,
          face: faces.get(entry.happened.market)!,
          owned,
        });
    }
    return tellStatement(tx, news);
  });
}

/** Which of these lines have been recorded. */
async function recordedLines(tx: Tx, refs: readonly string[]): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ ref: fills.venueRef })
    .from(fills)
    .where(inArray(fills.venueRef, [...refs]));
  return new Set(rows.flatMap(({ ref }) => ref ?? []));
}

/**
 * Records what no order of Auni's did as a done move of its own, dated when
 * the venue made it, and kept what it did (see happenedSchema).
 */
async function insertOutside(
  tx: Tx,
  venue: string,
  tool: Statement["tool"],
  outside: { readonly summary: string; readonly happened: Happened },
  at: Date,
): Promise<string> {
  const [action] = await tx
    .insert(actions)
    .values({
      summary: outside.summary,
      amountUsd: "0",
      ...begins("done"),
      venue,
      tool,
      input: {},
      details: outside.happened,
      createdAt: at,
    })
    .returning({ id: actions.id });
  return action!.id;
}

/**
 * The closing rule: whose a line is, by weight. The part of it that moves the
 * position toward zero is whoever held that just before, as the portfolio
 * splits a holding (see holdersOf): the acting move's specialist first, then
 * Other, then each other specialist in order (see saleOwners); for what Auni
 * didn't do, Other first. The part that opens or grows a position is the
 * acting move's specialist's, or Other's when Auni didn't act.
 */
export function lineOwners(
  line: StatementFill,
  books: ReadonlyMap<string, ReadonlyMap<string, bigint>>,
  place: string | null,
): (readonly [string | null, bigint])[] {
  const size = parseUnits(line.quantity, QUANTITY_DECIMALS);
  const held = line.before < 0n ? -line.before : line.before;
  const towardZero = held > 0n && line.before > 0n === (line.side === "sell");
  const closing = !towardZero ? 0n : size < held ? size : held;
  const weights = new Map(
    closing === 0n
      ? []
      : saleOwners(closing, place, holdersOf(line.before, books, fillIdentity(line), place)),
  );
  if (size > closing) weights.set(place, (weights.get(place) ?? 0n) + size - closing);
  return [...weights];
}
