import { ASK_TOOL_NAMES } from "@auni/shared";
import { and, desc, eq, ne, notInArray } from "drizzle-orm";

import { fenced } from "../agent/fence.ts";
import { reachWire } from "../always-on.ts";
import { db } from "../db/client.ts";
import { actions, automations, threads, type ThreadRow } from "../db/schema.ts";
import { gainOf } from "../money/books.ts";
import { portfolioNow, type Holding, type Portfolio } from "../money/portfolio.ts";
import { threadPot } from "../money/pot.ts";
import { cardMoneys } from "../money/recipes/index.ts";
import { dollars } from "../money/summaries.ts";
import { within } from "../money/swaps/shared.ts";
import { heldByTakes, takeChange, takeRecords } from "../money/takes.ts";
import { centsToUsd, sumUsd, usdToCents } from "../money/usd.ts";
import { cardsOf } from "../money/waiting.ts";

/** How long a turn waits for the portfolio read before going on without it. */
const PORTFOLIO_WAIT_MS = 6_000;

/**
 * The portfolio for a turn's prompt or facts: whatever finishes within `waitMs`,
 * or null when the read is slow or fails, so a turn never hangs waiting on a venue.
 */
export async function promptPortfolio(waitMs = PORTFOLIO_WAIT_MS): Promise<Portfolio | null> {
  try {
    return await within(portfolioNow(), waitMs);
  } catch (error) {
    console.warn(
      "portfolio unreadable for prompt:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Money cards still waiting for the owner's tap in OTHER threads: how much cash
 * they count on and a short line for each, so the agent doesn't double-promise cash.
 */
export async function waitingElsewhere(
  threadId: string,
): Promise<{ readonly countsOnUsd: string; readonly lines: readonly string[] }> {
  const rows = await db
    .select({ action: actions, title: threads.title })
    .from(actions)
    .leftJoin(threads, eq(threads.id, actions.threadId))
    .where(
      and(
        eq(actions.status, "awaiting_permission"),
        notInArray(actions.tool, [...ASK_TOOL_NAMES]),
        ne(actions.threadId, threadId),
      ),
    )
    .orderBy(desc(actions.createdAt));
  if (rows.length === 0) return { countsOnUsd: "0.00", lines: [] };
  const byCard = Map.groupBy(rows, ({ action }) => action.proposalId ?? action.id);
  const amounts: string[] = [];
  const lines: string[] = [];
  for (const [id, entries] of byCard) {
    const legs = entries.map(({ action }) => action);
    const moneys = cardMoneys(legs);
    for (const money of moneys) if (money?.flow === "in") amounts.push(money.usd);
    const where = entries[0]?.title?.trim() || "another thread";
    const summary = legs.map((leg) => leg.summary).join("; ");
    lines.push(`- card ${id} in "${where}": ${summary}`);
  }
  return { countsOnUsd: sumUsd(amounts), lines };
}

/** Prompt reminder of cards waiting for the owner's tap here (for `replaces`) and elsewhere. */
export async function waitingCardsContext(threadId: string): Promise<string | null> {
  const [hereRows, elsewhere] = await Promise.all([
    db
      .select()
      .from(actions)
      .where(
        and(
          eq(actions.threadId, threadId),
          eq(actions.status, "awaiting_permission"),
          notInArray(actions.tool, [...ASK_TOOL_NAMES]),
        ),
      )
      .orderBy(actions.createdAt),
    waitingElsewhere(threadId),
  ]);
  const here = cardsOf(hereRows);
  const parts: string[] = [];
  if (here.length > 0) {
    parts.push(
      "Cards still waiting for the owner's tap in THIS thread (pass `replaces` when proposing a new money card):\n" +
        here.map((card) => `- card ${card.id}: ${card.asks}`).join("\n"),
    );
  }
  if (elsewhere.lines.length > 0) {
    const promised =
      usdToCents(elsewhere.countsOnUsd) > 0n
        ? ` (counting on ${dollars(elsewhere.countsOnUsd)} of cash)`
        : "";
    parts.push(
      `Cards still waiting in OTHER threads${promised} (can be taken back with retract_cards if outdated):\n` +
        elsewhere.lines.join("\n"),
    );
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function holdingLine(holding: Holding, made = ""): string {
  const value = holding.usdValue ? dollars(holding.usdValue) : "unpriced";
  const side = holding.short ? " short" : "";
  const lev = holding.leverage ? ` ${holding.leverage}x` : "";
  return `${holding.symbol}${lev}${side} (${value} on ${holding.chain}${made})`;
}

/** Signed dollars, as the owner reads a gain: "+$50", "-$12.40". */
function signedDollars(usd: string): string {
  return usd.startsWith("-") ? `-${dollars(usd.slice(1))}` : `+${dollars(usd)}`;
}

/** A thread's own position, with what it made since this thread bought it, as Money shows it. */
function positionLine(holding: Holding): string {
  const gain = gainOf(holding);
  return holdingLine(
    holding,
    gain ? `, ${signedDollars(centsToUsd(gain.changeCents))} since entry` : "",
  );
}

/**
 * Cash as Money shows it, and savings a take holds named apart: the owner's buying power counts
 * them, since they can be taken out, but they are that take's, never idle cash.
 */
function cashLine(portfolio: Portfolio, cashUsd: string): string {
  const saved = usdToCents(portfolio.cash.usdValue) - usdToCents(cashUsd);
  return saved > 0n
    ? `${dollars(cashUsd)} cash (plus ${dollars(centsToUsd(saved))} in savings a take holds; buying power ${dollars(portfolio.cash.usdValue)})`
    : `${dollars(cashUsd)} cash`;
}

/**
 * Everything about this thread and the owner's current portfolio/environment,
 * appended to the turn's system reminder.
 */
export async function threadContext(thread: ThreadRow): Promise<string> {
  const [portfolio, records, watches, reach] = await Promise.all([
    promptPortfolio(),
    takeRecords(),
    db
      .select({
        id: automations.id,
        description: automations.description,
        status: automations.status,
      })
      .from(automations)
      .where(and(eq(automations.threadId, thread.id), eq(automations.status, "active"))),
    reachWire().catch(() => null),
  ]);

  const lines: string[] = [];
  lines.push(`Thread: "${thread.title}" (id ${thread.id}).`);

  if (thread.actMode === "within_limits" && Number(thread.budgetUsd) > 0) {
    const pot = await threadPot(db, thread);
    const free = centsToUsd(pot.freeCashCents > 0n ? pot.freeCashCents : 0n);
    lines.push(
      `Permission mode: Auto within ${dollars(thread.budgetUsd)} budget (${dollars(free)} remaining free to buy on its own; can also auto-sell holdings opened in this thread; bridges, perps, and withdrawals still ask).`,
    );
  } else {
    lines.push("Permission mode: Ask first (every money move waits for the owner's tap).");
  }

  if (reach) {
    lines.push(
      reach.staysOn.stays
        ? `Environment: Running always on (${reach.machine}). Watches and scheduled check-ins stay live 24/7.`
        : `Environment: Running locally on ${reach.machine} (pauses when this computer sleeps or closes).`,
    );
  }

  if (portfolio) {
    const split = heldByTakes(portfolio, records);
    const mine = split.threads.get(thread.id) ?? [];
    if (mine.length > 0) {
      const { changeUsd, costUsd } = takeChange(mine);
      const together =
        changeUsd && costUsd
          ? `; together ${signedDollars(changeUsd)} since entry on ${dollars(costUsd)} put in`
          : "";
      lines.push(
        `Positions opened in this thread: ${mine.map(positionLine).join(", ")}${together}.`,
      );
    }
    const topAssets = [...portfolio.assets.holdings]
      .sort((a, b) => Number(b.usdValue ?? 0) - Number(a.usdValue ?? 0))
      .slice(0, 8);
    const holdingsSummary =
      topAssets.length > 0
        ? `; holdings: ${topAssets.map((holding) => holdingLine(holding)).join(", ")}`
        : "";
    const missing =
      portfolio.unavailable.length > 0
        ? ` (unavailable right now: ${portfolio.unavailable.join(", ")})`
        : "";
    lines.push(
      `Wallet portfolio: ${dollars(portfolio.totalUsd)} total, ${cashLine(portfolio, split.cashUsd)}${holdingsSummary}${missing}.`,
    );
  }

  if (watches.length > 0) {
    lines.push(
      `Active watches in this thread: ${watches.map((w) => `"${w.description}" (${w.id})`).join("; ")}.`,
    );
  }

  if (thread.notes?.trim()) {
    lines.push(
      "Your working notes for this thread (update with update_thread_notes):\n" +
        fenced("thread_notes", thread.notes.trim(), 2_000),
    );
  }

  return lines.join("\n");
}
