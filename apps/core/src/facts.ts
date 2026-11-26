import { knownAsset, type FactSource, type OwnerSignals } from "@auni/shared";
import { and, desc, eq, exists, isNull, or, sql } from "drizzle-orm";

import { theOwner } from "./auth/owner.ts";
import { db } from "./db/client.ts";
import { automations, threads, type OwnerRow, type ThreadRow } from "./db/schema.ts";
import { startFrom, type FactStart, type AppFact, type OwnerSeen } from "./apps/contract.ts";
import { factSources } from "./apps/registry.ts";
import { promptPortfolio } from "./conversation/context.ts";
import { dayMoves } from "./money/day-moves.ts";
import { holdingFaces, LOGOS, paysFees } from "./money/holdings.ts";
import type { Holding, Portfolio } from "./money/portfolio.ts";
import { dollars } from "./money/summaries.ts";
import { hasWallet } from "./money/wallets.ts";
import { within } from "./money/swaps/shared.ts";
import { centsToUsd, signedUsdToCents, usdToCents } from "./money/usd.ts";
import { heldByTakes, takeRecords, type TakeRecords } from "./money/takes.ts";
import { startOfDay } from "./money/value-history.ts";

// What Auni sees that matters to the owner now: their own money, active threads, and what each app
// sees (App.facts). Read fresh every time and never kept: a new chat's starting points are
// written from them (conversation/starting-points.ts). Each fact names where it came from, so
// whatever is made of it can cite it.

/**
 * Something Auni sees now, where it came from, a picture of what it's about (null for the
 * owner's own money or Auni), and ways the owner might start a chat from it.
 */
export interface Fact {
  readonly text: string;
  readonly source: FactSource;
  readonly image: string | null;
  readonly starts: readonly FactStart[];
}

/** Auni's own facts' app, as a source names it. */
const AUNI = "auni";
/** How long an app may take to say what it sees; past this it is left out. */
export const FACT_WAIT_MS = 6_000;
/** Their largest holdings an app is told of. */
const HOLDINGS_SEEN = 10;
/** Of those, the ones that are a fact of their own. */
const HOLDINGS_TOLD = 3;
const ACTIVE_THREADS_TOLD = 3;

/**
 * How long the facts wait for the owner's money. Nobody's turn waits on them, and a reading
 * right after Auni starts takes about as long as a turn's wait (6 seconds, measured): starting
 * points written then said "The owner's money couldn't be read just now", and offered "Why
 * can't you read my wallet?" for an hour.
 */
const FACTS_PORTFOLIO_WAIT_MS = 30_000;

/** Everything Auni sees now: their money first, which is always there, then their signals & the rest. */
export async function readFacts(): Promise<Fact[]> {
  const [wallet, portfolio, records, activeThreads, me] = await Promise.all([
    hasWallet().catch(() => true),
    promptPortfolio(FACTS_PORTFOLIO_WAIT_MS),
    takeRecords(),
    db
      .select()
      .from(threads)
      .where(
        and(
          isNull(threads.archivedAt),
          or(
            eq(threads.actMode, "within_limits"),
            exists(
              db
                .select({ one: sql`1` })
                .from(automations)
                .where(and(eq(automations.threadId, threads.id), eq(automations.status, "active"))),
            ),
          ),
        ),
      )
      .orderBy(desc(threads.updatedAt))
      .limit(ACTIVE_THREADS_TOLD),
    theOwner(),
  ]);
  const held = await heldNow(portfolio);
  const seen: OwnerSeen = {
    holdings: held.map(({ holding, name, image }) => ({
      symbol: holding.symbol,
      name,
      usdValue: holding.usdValue!,
      image,
    })),
  };
  return [
    ...(wallet ? moneyFacts(portfolio, records) : [NO_WALLET_YET]),
    ...activeThreads.map(activeThreadFact),
    ...held.slice(0, HOLDINGS_TOLD).map(holdingFact),
    ...personalFacts(me),
    ...(await appFacts(seen)),
  ];
}

/** Facts drawn from the owner's connected signals (X handle, watch-only wallets, learned profile). */
function personalFacts(
  me: Pick<OwnerRow, "xHandle" | "profileSummary" | "profileSignals">,
): Fact[] {
  const out: Fact[] = [];
  const signals: OwnerSignals | null = me.profileSignals ?? null;
  const holdings = signals?.watchedHoldings ?? [];
  for (const h of holdings.slice(0, 2)) {
    const value = dollars(h.usdValue);
    const asset = knownAsset(h.symbol);
    out.push({
      text: `A watched external wallet holds ${value} of ${h.name} (${h.symbol}) on ${h.chain} (watch-only; not in Auni's wallet).`,
      source: { app: AUNI, label: `Watched ${h.symbol}`, link: "/app?settings=you" },
      image: asset?.logoUrl ?? null,
      starts: startFrom(
        `A wallet I'm watching holds about ${value} of ${h.name} on ${h.chain}. What's your take on ${h.name} right now, and are there smart angles around it?`,
        [
          { statement: `Watched ${h.symbol}: ${value}.`, action: "Any angles?" },
          { statement: `You watch ${h.name}.`, action: "Any angles?" },
        ],
      ),
    });
  }
  const topics = signals?.xTopics ?? [];
  if (me.profileSummary || topics.length > 0) {
    const parts = [
      me.profileSummary ? `Owner profile: ${me.profileSummary}` : null,
      topics.length > 0 ? `Owner's active themes: ${topics.join(", ")}.` : null,
      me.xHandle ? `Connected X handle: @${me.xHandle}.` : null,
    ].filter(Boolean);
    const firstTopic = topics[0];
    out.push({
      text: parts.join(" "),
      source: { app: AUNI, label: "Your profile", link: "/app?settings=you" },
      image: null,
      starts: firstTopic
        ? startFrom(
            `Based on my interest in ${firstTopic}, what's moving right now that could make a sharp take or position?`,
            [
              { statement: `${firstTopic} lately.`, action: "What's moving?" },
              { statement: "Tailored to you.", action: "Explore ideas" },
            ],
          )
        : [],
    });
  }
  return out;
}

/**
 * What each app sees, cited as that app's whatever it says of itself. One that fails, or
 * takes past FACT_WAIT_MS, is left out with a line in the log.
 */
export async function appFacts(
  seen: OwnerSeen,
  from: ReturnType<typeof factSources> = factSources(),
): Promise<Fact[]> {
  const each = await Promise.all(
    from.map(async ({ about, facts }) => {
      const stop = new AbortController();
      try {
        const found: readonly AppFact[] = await within(facts(seen, stop.signal), FACT_WAIT_MS);
        return found.map(({ text, label, link, image, starts }): Fact => ({
          text,
          source: { app: about.id, label, link },
          image,
          starts,
        }));
      } catch (error) {
        console.warn(
          `${about.name} couldn't say what it sees:`,
          error instanceof Error ? error.message : error,
        );
        return [];
      } finally {
        stop.abort();
      }
    }),
  );
  return each.flat();
}

interface Held {
  readonly holding: Holding;
  /** As the portfolio names it: "NVIDIA", "Will the Fed cut in December?". */
  readonly name: string;
  /** Its logo, as the portfolio shows it, or null. */
  readonly image: string | null;
  /** Signed dollars it moved today, or null when that can't be told. */
  readonly dayMove: string | null;
}

/**
 * Their largest holdings besides cash and the coin their fees are paid in, which is no holding
 * to talk about selling (see paysFees), each with its name and its move today.
 */
async function heldNow(portfolio: Portfolio | null): Promise<Held[]> {
  const candidates = (portfolio?.holdings ?? []).filter(
    (holding) => !holding.cash && usdToCents(holding.usdValue ?? "0") > 0n,
  );
  const fees = await Promise.all(candidates.map(paysFees));
  const holdings = candidates
    .filter((_, index) => !fees[index])
    .toSorted((a, b) => Number(b.usdValue) - Number(a.usdValue))
    .slice(0, HOLDINGS_SEEN);
  if (holdings.length === 0) return [];
  const { timeZone } = await theOwner();
  const [faces, moves] = await Promise.all([
    // Names and logos are a nicety: a slow stock catalog leaves each its symbol.
    within(holdingFaces(holdings), FACT_WAIT_MS).catch(() => null),
    dayMoves(holdings, startOfDay(timeZone)),
  ]);
  return holdings.map((holding, index) => ({
    holding,
    name: faces?.[index]?.name ?? holding.symbol,
    image: faces?.[index]?.logoUrl ?? null,
    dayMove: moves[index] ?? null,
  }));
}

const NEW_HERE: FactStart = {
  statement: "New to Auni?",
  action: "Start here",
  prompt: "I'm new to Auni. What can you do with my money, and what would a first take look like?",
};
const A_BELIEF: FactStart = {
  statement: "Have a belief?",
  action: "Make it real",
  prompt:
    "I have a belief about where the world is going. Ask me what it is, then show me how you'd build a position for it.",
};
const MOVING: FactStart = {
  statement: "Markets today.",
  action: "What's moving?",
  prompt:
    "What's moving in the markets today that I might hold a view on? Pick a few and tell me why they're moving.",
};
const FIRST_MONEY: FactStart = {
  statement: "Your wallet is empty.",
  action: "Get started",
  prompt: "How much money do I need to start with Auni, and what's the easiest way to add it?",
};

const START_SMALL: FactStart = {
  statement: "Starting small?",
  action: "Try $50",
  prompt: "I'd like to start small. What could a first take look like with $50?",
};

/**
 * Before the owner's first take there is no wallet to be empty: it's made as that take is sent,
 * unless they bring their own first (routes/setup.ts), so first run's line under the box and
 * these never say two things. One that couldn't be made then is made by the first move.
 */
const NO_WALLET_YET: Fact = {
  text: "The owner has no wallet yet: Auni makes one with their first take, or with the first move if it couldn't then.",
  source: { app: AUNI, label: "Your money", link: "/app" },
  image: null,
  starts: [NEW_HERE, A_BELIEF, START_SMALL, MOVING],
};

/** A look over their money, by its total when that could be read. */
function checkIn(total: string | null): FactStart[] {
  return startFrom("Look over my portfolio. How is it doing, and what stands out to you?", [
    ...(total ? [{ statement: `You have ${dollars(total)}.`, action: "Look it over" }] : []),
    { statement: "Your portfolio.", action: "Look it over" },
  ]);
}

/**
 * Their money as a whole, there even when it's empty or can't be read, and their cash as a fact
 * of its own, which wears cash's own mark as the portfolio shows it.
 */
function moneyFacts(portfolio: Portfolio | null, records: TakeRecords): Fact[] {
  const source = { app: AUNI, label: "Your money", link: "/app" };
  if (!portfolio)
    return [
      {
        text: "The owner's money couldn't be read just now.",
        source,
        image: null,
        starts: [...checkIn(null), A_BELIEF, MOVING, NEW_HERE],
      },
    ];
  if (usdToCents(portfolio.totalUsd) === 0n)
    return [
      {
        text: "The owner hasn't added any money yet: their wallet is empty.",
        source,
        image: null,
        starts: [FIRST_MONEY, NEW_HERE, A_BELIEF, MOVING],
      },
    ];
  // Cash as Money shows it: savings a take bought ("Keep my idle cash earning") are already at work.
  const cash = heldByTakes(portfolio, records).cashUsd;
  const whole: Fact = {
    text: `The owner has ${dollars(portfolio.totalUsd)} in all, ${dollars(cash)} of it cash.`,
    source,
    image: null,
    starts: [...checkIn(portfolio.totalUsd), A_BELIEF, MOVING, NEW_HERE],
  };
  if (usdToCents(cash) === 0n) return [whole];
  return [
    whole,
    {
      text: `${dollars(cash)} of the owner's money is cash, waiting to be used.`,
      source: { app: AUNI, label: "Your cash", link: "/app" },
      image: LOGOS.usdc,
      // To the cent where that fits, else in whole dollars.
      starts: startFrom(`I have ${dollars(cash)} in cash. What would you do with it?`, [
        { statement: `${dollars(cash)} is in cash.`, action: "Put it to work" },
        { statement: `${wholeDollars(cash)} is in cash.`, action: "Put it to work" },
        { statement: "Cash is waiting.", action: "Put it to work" },
      ]),
    },
  ];
}

function activeThreadFact(thread: ThreadRow): Fact {
  const name = thread.title?.trim() || "Active thread";
  const notes = thread.notes?.trim() ?? "";
  const mode =
    thread.actMode === "within_limits"
      ? `running Auto up to ${dollars(thread.budgetUsd)}`
      : "actively watching";
  return {
    text: `The owner's thread "${name}" is ${mode}.${notes ? ` Notes: ${notes.slice(0, 140)}` : ""}`,
    source: { app: AUNI, label: name, link: `/app/chat/${thread.id}` },
    image: null,
    starts: startFrom(`How is "${name}" looking right now, and is there anything to adjust?`, [
      { statement: `${name} is running.`, action: "Check in" },
      { statement: `Check ${name}.`, action: "Review" },
    ]),
  };
}

function holdingFact({ holding, name, image, dayMove }: Held): Fact {
  const value = dollars(holding.usdValue!);
  const moved = dayMove ? signedUsdToCents(dayMove) : 0n;
  const way = moved < 0n ? "down" : "up";
  const amount = dollars(centsToUsd(moved < 0n ? -moved : moved));
  const today = `${way} ${amount} today`;
  return {
    text: `The owner holds ${value} of ${name}${moved === 0n ? "" : `, ${today}`}.`,
    source: { app: AUNI, label: name, link: "/app" },
    image,
    starts: startFrom(
      `I hold ${value} of ${name}. How is it doing, and would you change anything?`,
      moved === 0n
        ? [
            { statement: `You hold ${value} of ${name}.`, action: "Review it" },
            { statement: `Your ${value} of ${name}.`, action: "Review it" },
            { statement: `Your ${name}.`, action: "Review it" },
          ]
        : [
            { statement: `${name} is ${today}.`, action: "What next?" },
            { statement: `${name} is ${way} ${amount}.`, action: "What next?" },
            { statement: `Your ${name} is ${way}.`, action: "What next?" },
          ],
    ),
  };
}

/** "$9,839" for $9,839.35: dollars rounded to the nearest whole one. */
function wholeDollars(usd: string): string {
  const cents = usdToCents(usd);
  return dollars(centsToUsd(((cents + 50n) / 100n) * 100n));
}
