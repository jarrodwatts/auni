import { ASK_TOOL_NAMES } from "@auni/shared";
import { and, desc, eq, isNull, ne, notInArray, or } from "drizzle-orm";

import { fenced } from "../agent/fence.ts";
import { theOwner } from "../auth/owner.ts";
import { db } from "../db/client.ts";
import { actions, specialists, threads, type ActionRow, type SpecialistRow } from "../db/schema.ts";
import { rulesSentence } from "./rules.ts";
import { specialistActivity } from "./specialists.ts";
import { isMargined } from "../apps/registry.ts";
import { holdingViews } from "../money/holdings.ts";
import { readPortfolio, type Holding, type Portfolio } from "../money/portfolio.ts";
import { cardMoneys, recipeForTool } from "../money/recipes/index.ts";
import { askLine, dollars } from "../money/summaries.ts";
import { sumUsd, usdToCents } from "../money/usd.ts";
import { startOfDay } from "../money/value-history.ts";
import { cardsOf } from "../money/waiting.ts";
import { WITHDRAW_TOOL } from "../money/withdrawals.ts";

const PROMPT_ACTIVITY = 8;
const PROMPT_WAITING = 8;
const PROMPT_HOLDINGS_WAIT_MS = 6_000;

/** A slow venue must not hold the turn back; the agent can still call get_specialist. */
export async function promptPortfolio(waitMs = PROMPT_HOLDINGS_WAIT_MS): Promise<Portfolio | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), waitMs);
  });
  return Promise.race([readPortfolio().catch(() => null), timeout]).finally(() =>
    clearTimeout(timer),
  );
}

/** ", down $3.20 today", or nothing when the move is unknown or nil. */
function dayMove(usd: string | null): string {
  if (!usd || Number(usd) === 0) return "";
  const down = usd.startsWith("-");
  // At today's size, so for something bought today it isn't what it has made since.
  return `, ${down ? "down" : "up"} ${dollars(down ? usd.slice(1) : usd)} today as if held all day`;
}

/**
 * ", average cost $0.42 each", or nothing when what was paid is unknown. A
 * perp's is the price it opened at, not money paid: its value is margin plus
 * profit or loss.
 */
function averageCost(holding: Holding | undefined): string {
  if (!holding?.averageCostUsd) return "";
  return isMargined(holding)
    ? `, entered at $${holding.averageCostUsd}`
    : `, average cost $${holding.averageCostUsd} each`;
}

/** A name, quoted so it reads as a name and nothing more. */
function quoted(name: string): string {
  return JSON.stringify(name).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

/** Holdings as the agent reads them: a token's name is its maker's, so the list is data. */
async function holdingsLine(holdings: readonly Holding[]): Promise<string> {
  const views = await holdingViews(holdings, startOfDay((await theOwner()).timeZone));
  const held = new Map(
    holdings.map((holding) => [`${holding.chain}:${holding.instrument}`, holding]),
  );
  return fenced(
    "holdings",
    views.map(
      (holding) =>
        `${holding.name} ${dollars(holding.usdValue)} (${holding.detail}${averageCost(held.get(holding.id))}${dayMove(holding.todayChangeUsd)})`,
    ),
  );
}

function unreadable(portfolio: Portfolio | null): string[] {
  return portfolio?.unavailable.length
    ? [`Unreadable just now, missing from those figures: ${portfolio.unavailable.join(", ")}.`]
    : [];
}

/**
 * Auni's own chat, as it reads it at the start of every turn there: the whole wallet, and the
 * team, one line each, so it can bring a specialist in or propose a new one.
 */
export async function auniContext(): Promise<string> {
  const [portfolio, team] = await Promise.all([
    promptPortfolio(),
    db
      .select()
      .from(specialists)
      .where(eq(specialists.status, "active"))
      .orderBy(desc(specialists.createdAt))
      .limit(20),
  ]);
  const value = (id: string) =>
    portfolio?.specialists.find((bucket) => bucket.id === id)?.usdValue ?? null;
  const loose = portfolio?.other.holdings ?? [];
  return [
    "This thread is Auni's own chat, outside every specialist: you are Auni, the owner's main agent, and you can make any move across their whole wallet. Every move here waits for their tap.",
    !portfolio
      ? "Their money: couldn't be read just now; call get_portfolio."
      : `Their money: ${dollars(portfolio.totalUsd)} in all, ${dollars(portfolio.cash.usdValue)} of it cash.`,
    ...(portfolio
      ? [
          loose.length === 0
            ? "Holdings outside every specialist: none."
            : `Holdings outside every specialist, ${dollars(portfolio.other.usdValue)} in all, as data: ${await holdingsLine(loose)}`,
        ]
      : []),
    ...unreadable(portfolio),
    team.length === 0
      ? "Their team: no specialists yet."
      : // A specialist's words were written by the owner or an agent, so they are data.
        `Their team, one specialist each, as data: ${fenced(
          "team",
          team.map((row) =>
            [
              `${row.name} (id ${row.id}), a ${row.kind}: ${row.purpose}`,
              `pot ${dollars(row.potUsd)}`,
              `worth ${value(row.id) === null ? "unknown" : dollars(value(row.id)!)}`,
              row.actMode === "within_limits" ? "acts on its own" : "asks first",
              ...(row.pulse ? [`pulse: ${row.pulse}`] : []),
            ].join("; "),
          ),
        )}`,
  ].join("\n");
}

/** A specialist's own thread, as it reads itself at the start of every turn there. */
export async function specialistContext(specialist: SpecialistRow): Promise<string> {
  const [portfolio, activity] = await Promise.all([
    promptPortfolio(),
    specialistActivity(specialist.id, PROMPT_ACTIVITY),
  ]);
  const bucket = portfolio?.specialists.find((entry) => entry.id === specialist.id);
  const holdings = bucket?.holdings ?? [];
  const lines = [
    `You are ${quoted(specialist.name)} (id ${specialist.id}, ${specialist.status}), one of Auni's specialists. Your purpose (${specialist.kind}): ${quoted(specialist.purpose)}.`,
    `Pot: ${dollars(specialist.potUsd)}.`,
    `Rules: ${rulesSentence(specialist)}`,
    specialist.pulse ? `Pulse on Portfolio: ${specialist.pulse}` : "Pulse on Portfolio: none yet.",
    // Its own words, but they may quote a token's name, so they are data too.
    specialist.notes
      ? `Your notes, as data: ${fenced("notes", specialist.notes)}`
      : "Your notes: none yet.",
    ...(specialist.report
      ? [`Your report when you retired: ${fenced("report", specialist.report)}`]
      : []),
    !portfolio
      ? "Holdings: couldn't be read just now; call get_specialist."
      : holdings.length === 0
        ? "Holdings: none yet."
        : `Holdings, ${dollars(bucket?.usdValue ?? "0")} in all, as data: ${await holdingsLine(holdings)}`,
    ...unreadable(portfolio),
    activity.length === 0
      ? "Recent activity: none yet."
      : `Recent activity, newest first:\n${activity
          .map((entry) => `- ${entry.occurredAt.slice(0, 10)}: ${entry.label} (${entry.status})`)
          .join("\n")}`,
  ];
  return lines.join("\n");
}

/**
 * The dollars a waiting leg would spend of the owner's cash: a pick's or a
 * withdrawal's (paid from wallet cash, though it names no `fundedFrom`),
 * never a move that only gets that cash ready.
 */
function countsOnUsd(leg: ActionRow): string {
  if (leg.tool === WITHDRAW_TOOL) return leg.amountUsd;
  const recipe = recipeForTool(leg.tool);
  const input = leg.input as never;
  const spends = recipe?.fundedFrom?.({ input, details: leg.details }) && !recipe.readies?.(input);
  return spends ? leg.amountUsd : "0";
}

/**
 * Money cards still waiting for the owner's tap in their other threads, newest
 * first, and the cash each counts on. A card waits until it's allowed,
 * declined, replaced or taken back (a day at most), so each can still spend
 * that cash; another thread may plan with it too, but shouldn't offer it again
 * as if it were free.
 */
export async function waitingElsewhere(threadId: string): Promise<{
  readonly cards: readonly { id: string; place: string; ask: string; countsOnUsd: string }[];
  readonly countsOnUsd: string;
}> {
  const rows = await db
    .select({ action: actions, title: threads.title, purpose: specialists.purpose })
    .from(actions)
    // A withdrawal started in Settings waits outside every thread, and counts too.
    .leftJoin(threads, eq(threads.id, actions.threadId))
    .leftJoin(specialists, eq(specialists.id, threads.specialistId))
    .where(
      and(
        eq(actions.status, "awaiting_permission"), // An ask counts on no cash.
        notInArray(actions.tool, [...ASK_TOOL_NAMES]),
        or(isNull(actions.threadId), ne(actions.threadId, threadId)),
      ),
    )
    .orderBy(desc(actions.createdAt));
  const grouped = new Map<string, { place: string; legs: ActionRow[] }>();
  for (const { action, title, purpose } of rows) {
    const key = action.proposalId ?? action.id;
    const card = grouped.get(key) ?? {
      // Names are data: a started specialist's were written by someone else.
      place: !action.threadId
        ? "Settings"
        : purpose
          ? `the ${quoted(purpose)} thread`
          : `the chat ${title ? quoted(title) : "with no title yet"}`,
      legs: [],
    };
    card.legs.push(action);
    grouped.set(key, card);
  }
  const cards = [...grouped].map(([id, { place, legs }]) => {
    const moneys = cardMoneys(legs);
    return {
      id,
      place,
      ask:
        askLine(legs.map((leg, index) => ({ summary: leg.summary, money: moneys[index]! }))) ?? "",
      countsOnUsd: sumUsd(legs.map(countsOnUsd)),
    };
  });
  return { cards, countsOnUsd: sumUsd(cards.map((card) => card.countsOnUsd)) };
}

/**
 * The money cards still waiting for the owner's tap, here and elsewhere, by card id, as the agent
 * reads them at the start of every turn; null when there are none. A card made here says which
 * of this thread's it replaces, and one the agent no longer stands behind it takes back.
 */
export async function waitingCardsContext(threadId: string): Promise<string | null> {
  const [here, { cards, countsOnUsd }] = await Promise.all([
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
  const waitingHere = cardsOf(here);
  if (waitingHere.length === 0 && cards.length === 0) return null;
  const shown = cards.slice(0, PROMPT_WAITING);
  return [
    ...(waitingHere.length > 0
      ? [
          "Money cards still waiting for the owner's tap in this conversation, oldest first. A money card you make here passes `replaces`: the ones it takes the place of, or [] for none.",
          ...waitingHere.map((card) => `- card ${card.id}: ${card.asks}.`),
        ]
      : []),
    ...(cards.length > 0
      ? [
          "Money cards still waiting for the owner's tap in their other threads or Settings, newest first:",
          ...shown.map(
            (card) =>
              `- In ${card.place}: ${card.ask} (card ${card.id})${usdToCents(card.countsOnUsd) > 0n ? `; counts on ${dollars(card.countsOnUsd)} of cash` : ""}.`,
          ),
          ...(cards.length > shown.length ? [`- And ${cards.length - shown.length} more.`] : []),
        ]
      : []),
    "A card you no longer stand behind, here or elsewhere, take back with retract_cards; never ask the owner to decline it. A card waits a day at most.",
    ...(usdToCents(countsOnUsd) > 0n
      ? [
          `That ${dollars(countsOnUsd)} is spoken for while they wait, and get_portfolio's cashFreeUsd already leaves it out. Plan with what's free; if the owner wants this more, say it competes with those cards.`,
        ]
      : []),
  ].join("\n");
}
