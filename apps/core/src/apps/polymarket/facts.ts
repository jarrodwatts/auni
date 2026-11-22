import { roughDollars } from "../../money/summaries.ts";
import { startFrom, type AppFact } from "../contract.ts";
import { GAMMA, getJson } from "./http.ts";
import type { GammaMarket } from "./markets.ts";

// What Polymarket is busy with now: its most traded open questions, outside sports, each at the
// chance its market puts on it. Read from Gamma, which needs no key.

const EVENTS_READ = 10;
const FACTS = 5;
/** Polymarket's own tag for sports and esports, which a money agent's ideas leave out. */
const SPORTS_TAG = "1";
/** A market priced past this either way is all but settled, so it makes no question to start from. */
const SETTLED = 0.97;

interface TopEvent {
  readonly title: string;
  readonly slug: string;
  readonly volume24hr?: number;
  /** Its picture, as Polymarket shows it beside the question. */
  readonly icon?: string;
  readonly image?: string;
  readonly markets?: readonly GammaMarket[];
}

export async function polymarketFacts(): Promise<AppFact[]> {
  const events = await getJson<readonly TopEvent[]>(
    `${GAMMA}/events?${new URLSearchParams({
      active: "true",
      closed: "false",
      order: "volume24hr",
      ascending: "false",
      limit: String(EVENTS_READ),
      exclude_tag_id: SPORTS_TAG,
    })}`,
  );
  return events.flatMap((event) => eventFact(event) ?? []).slice(0, FACTS);
}

/** An open market's first outcome ("Yes", or a team) and the chance it has, or null. */
function firstOutcome(market: GammaMarket): { outcome: string; chance: number } | null {
  if (!market.active || market.closed || !market.enableOrderBook) return null;
  try {
    const outcomes = JSON.parse(market.outcomes ?? "[]") as unknown[];
    const chance = Number((JSON.parse(market.outcomePrices ?? "[]") as unknown[])[0]);
    if (typeof outcomes[0] !== "string" || !(chance > 1 - SETTLED && chance < SETTLED)) return null;
    return { outcome: outcomes[0], chance };
  } catch {
    return null;
  }
}

/**
 * The event as one fact: a single question at its chance, or a question of many outcomes at its
 * likeliest still in doubt. Null when every market in it is all but settled.
 */
function eventFact(event: TopEvent): AppFact | null {
  const open = (event.markets ?? []).flatMap((market) => {
    const first = firstOutcome(market);
    return first ? [{ market, ...first }] : [];
  });
  const lead = open.toSorted((a, b) => b.chance - a.chance)[0];
  if (!lead) return null;
  const pct = `${Math.round(lead.chance * 100)}%`;
  const single = (event.markets ?? []).length === 1;
  const question = single ? lead.market.question : event.title;
  const odds = single
    ? `is at ${pct} ${lead.outcome}`
    : `has ${lead.market.groupItemTitle ?? lead.market.question} at ${pct}`;
  const traded = event.volume24hr ? `, with ${roughDollars(event.volume24hr)} traded today` : "";
  return {
    text: `On Polymarket, "${question}" ${odds}${traded}.`,
    label: question,
    link: `https://polymarket.com/event/${encodeURIComponent(event.slug)}`,
    image: event.icon ?? event.image ?? null,
    // A question asked whole, or not at all: most are too long for one row, and offer none.
    starts: startFrom(
      `Polymarket's "${question}" ${odds}. Do you think that's right, and is there a position in it for me?`,
      single
        ? [
            { statement: question, action: `${pct}, really?` },
            { statement: event.title, action: `${pct}, really?` },
            { statement: question, action: "Weigh it up" },
          ]
        : [{ statement: question, action: "Weigh it up" }],
    ),
  };
}
