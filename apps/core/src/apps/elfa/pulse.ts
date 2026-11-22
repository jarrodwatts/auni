import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { knownAsset, type appCardSchema } from "@auni/shared";
import type { z } from "zod";

import { cached } from "../../money/swaps/shared.ts";
import { stockLogo } from "../../money/swaps/stock-index.ts";
import { feedDay, feedHistory } from "../../money/token-feeds.ts";
import { xStockCatalog } from "../../money/swaps/xstocks.ts";
import { ElfaError } from "./request.ts";
import type tapeSchema from "./tape.schema.ts";
import {
  daysAgo,
  findEvents,
  oncePerStory,
  percent,
  positioning,
  resolveEntity,
  type ElfaEntity,
  type ElfaEvent,
} from "./v3.ts";

/**
 * "The tape": one asset's week, read from Elfa (its stories and how accounts
 * are positioned) and DefiLlama (its price), around the agent's own take.
 */

type TapeData = z.input<typeof tapeSchema>;
type PulseStory = TapeData["stories"][number];
type Price = NonNullable<TapeData["price"]>;
/** The card the tape is: Elfa's own, drawn by tape.card.tsx from its data. */
type TapeCard = Omit<z.input<typeof appCardSchema>, "data"> & { readonly data: TapeData };

const WEEK_DAYS = 7;
/** Beads on a week's line, before it reads as noise. */
const STORIES = 12;
/** The agent reads the card whole, outside any fence, so its stories together stop here. */
const STORY_CHARS = 12_000;
const SOURCES = 5;
/** A logo is decoration: past this the card goes without one. */
const LOGO_WAIT_MS = 1_500;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1).trimEnd()}…` : trimmed;
}

/**
 * Elfa's words as the card holds them. The card reaches the agent unfenced, so
 * angle brackets become look-alikes that can't open or close a tag.
 */
function quoted(text: string, max: number): string {
  return clip(text.replaceAll("<", "‹").replaceAll(">", "›"), max);
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1_000).toISOString();
}

/** Only an https post on the web links, one with no tag in it; anything else shows as its handle alone. */
function safeLink(link: string | null): string | null {
  return link?.startsWith("https://") &&
    link.length <= 500 &&
    !/[<>]/u.test(link) &&
    URL.canParse(link)
    ? link
    : null;
}

function pulseStory(event: ElfaEvent, entityId: string): PulseStory {
  const reaction = event.impacts.find((impact) => impact.entityId === entityId)?.priceChange1d;
  return {
    id: event.id,
    at: iso(event.analyzedAt),
    title: quoted(event.alertTitle ?? "", 300),
    summary: event.summary?.trim() ? quoted(event.summary, 1_000) : null,
    implication: event.implication,
    weight: event.alertAction,
    sourceCount: Math.max(0, Math.round(event.originCount)),
    sources: event.citedSources.slice(0, SOURCES).map((source) => ({
      platform:
        source.source === "twitter" ? "x" : source.source === "telegram" ? "telegram" : "other",
      handle: source.handle?.trim() ? quoted(source.handle, 100) : null,
      link: safeLink(source.link),
    })),
    reactionPct: reaction == null ? null : percent(reaction),
  };
}

/** A story the agent asked to write on the chart, by the id market_news gave it, with its own short title. */
interface Highlight {
  readonly id: string;
  readonly label?: string;
}

type Tape = Pick<TapeData, "stories" | "highlights">;

/** The story an event tells: its storyline, or itself when it's in none. */
function storyOf(event: ElfaEvent): string {
  return event.storylineId ?? event.id;
}

/**
 * When the agent picks none: the week's biggest rise and biggest fall the next
 * day, then any other move by size, then the latest impactful stories.
 */
function biggestMoves(stories: readonly PulseStory[]): Tape["highlights"] {
  const moved = stories.filter((story) => story.reactionPct !== null && story.reactionPct !== 0);
  const bySize = moved.toSorted(
    (left, right) => Math.abs(right.reactionPct!) - Math.abs(left.reactionPct!),
  );
  const rise = bySize.find((story) => story.reactionPct! > 0);
  const fall = bySize.find((story) => story.reactionPct! < 0);
  const latestAlerts = stories.filter((story) => story.weight === "alert").toReversed();
  const picked = new Set(
    [rise, fall, ...bySize, ...latestAlerts].flatMap((story) => (story ? [story.id] : [])),
  );
  return [...picked].slice(0, 2).map((storyId) => ({ storyId, label: null }));
}

/**
 * The week's stories naming the asset, oldest first: the impactful ones
 * first, then the rest, each story once, while they fit STORY_CHARS. Calls
 * are traders' positions, not news. A story the agent picked is always kept,
 * and its pick lands on whichever report of that story the card shows.
 */
export function weekStories(
  alerts: readonly ElfaEvent[],
  monitors: readonly ElfaEvent[],
  entityId: string,
  picks: readonly Highlight[] = [],
): Tape {
  const events = [...alerts, ...monitors];
  const picked = new Map<string, Highlight>();
  for (const pick of picks.slice(0, 2)) {
    const event = events.find((each) => each.id === pick.id);
    if (event && !picked.has(storyOf(event))) picked.set(storyOf(event), pick);
  }
  const told = oncePerStory(events).filter((event) => event.alertTitle?.trim());
  const kept: { readonly event: ElfaEvent; readonly story: PulseStory }[] = [];
  let chars = 0;
  for (const event of [
    ...told.filter((event) => picked.has(storyOf(event))),
    ...told.filter((event) => !picked.has(storyOf(event))),
  ]) {
    const story = pulseStory(event, entityId);
    chars += JSON.stringify(story).length;
    if (kept.length === STORIES || chars > STORY_CHARS) break;
    kept.push({ event, story });
  }
  const stories = kept
    .toSorted((left, right) => left.event.analyzedAt - right.event.analyzedAt)
    .map(({ story }) => story);
  const highlights = kept.flatMap(({ event }) => {
    const pick = picked.get(storyOf(event));
    return pick ? [{ storyId: event.id, label: pick.label ? clip(pick.label, 48) : null }] : [];
  });
  return { stories, highlights: highlights.length ? highlights : biggestMoves(stories) };
}

async function stories(entityId: string, picks: readonly Highlight[]): Promise<Tape> {
  const week = { entityIds: entityId, from: daysAgo(WEEK_DAYS), limit: 30 };
  const [alerts, monitors] = await Promise.all([
    findEvents({ ...week, alertAction: "alert" }),
    findEvents({ ...week, alertAction: "monitor" }),
  ]);
  return weekStories(alerts, monitors, entityId, picks);
}

/** Core's price id for the asset: a token by its CoinGecko id, a stock by its xStock on Solana. */
async function priceId(entity: ElfaEntity): Promise<string | null> {
  const coingecko = entity.externalIds?.coingeckoId;
  if (coingecko) return `coingecko:${coingecko}`;
  if (entity.entityType !== "equity" || !entity.symbol) return null;
  const ticker = entity.symbol.toLowerCase();
  const stock = (await xStockCatalog()).find((each) => each.ticker.toLowerCase() === ticker);
  return stock?.solanaMint ? `solana:${stock.solanaMint}` : null;
}

// Two-hourly over the week, as the card's line draws it.
const weekOf = cached(10 * 60_000, async (id) =>
  (await feedHistory(id, "2h", daysAgo(WEEK_DAYS) * 1_000))
    .filter((point) => Number.isFinite(point.price))
    .map((point) => ({ at: new Date(point.at).toISOString(), value: point.price })),
);

export function weekPrice(points: Price["points"], latest: number | undefined): Price | null {
  const now = latest ?? points.at(-1)?.value;
  const first = points[0]?.value;
  if (!now || now <= 0 || !first || points.length < 2) return null;
  return {
    now,
    weekChangePct: Math.round(((now - first) / first) * 10_000) / 100,
    points: [...points, { at: new Date().toISOString(), value: now }],
  };
}

async function price(entity: ElfaEntity): Promise<Price | null> {
  const id = await priceId(entity);
  if (!id) return null;
  const [points, latest] = await Promise.all([weekOf(id), feedDay(id)]);
  return weekPrice(points, latest.price);
}

/** Auni's own artwork for an asset it knows, or the stock's. */
async function logo(entity: ElfaEntity): Promise<string | null> {
  const symbol = entity.symbol;
  if (!symbol) return null;
  const known = knownAsset(symbol);
  if (known) return known.logoUrl;
  return entity.entityType === "equity" ? stockLogo(symbol) : null;
}

/** Logs what a part of the card couldn't read and carries on without it. */
function without<T>(part: string, read: Promise<T>): Promise<T | null> {
  return read.catch((error: unknown) => {
    console.error(`market pulse ${part} unavailable`, error);
    return null;
  });
}

/**
 * The card for one token or stock. Its stories are the card, so failing to
 * read them fails it; price, positioning and logo each drop out on their own.
 */
export async function marketPulse(input: {
  readonly asset: string;
  readonly assetType?: "token" | "equity";
  readonly take: string;
  readonly highlights?: readonly Highlight[];
}): Promise<TapeCard> {
  const entity = await resolveEntity(
    input.asset,
    input.assetType ? [input.assetType] : ["token", "equity"],
  );
  if (!entity) {
    throw new ElfaError(
      `Elfa doesn't know "${input.asset}" as a token or stock; try its ticker or its full name.`,
    );
  }
  const [week, weekOfPrice, positions, logoUrl] = await Promise.all([
    stories(entity.id, input.highlights ?? []),
    without("price", price(entity)),
    without("positioning", positioning(entity.id)),
    without("logo", Promise.race([logo(entity), sleep(LOGO_WAIT_MS, null)])),
  ]);
  const name = quoted(entity.name ?? entity.symbol ?? input.asset, 120);
  return {
    kind: "app",
    id: randomUUID(),
    title: clip(`${name}, the last 7 days`, 160),
    updatedAt: new Date().toISOString(),
    app: "elfa",
    view: "tape",
    data: {
      asset: { name, symbol: entity.symbol ? quoted(entity.symbol, 24) : null, logoUrl },
      price: weekOfPrice,
      ...week,
      positioning: positions
        ? {
            long: Math.max(0, Math.round(positions.openLong)),
            short: Math.max(0, Math.round(positions.openShort)),
          }
        : null,
      take: clip(input.take, 400),
    },
  };
}

/** What the card shows, in numbers the agent can talk about. */
export function pulseSummary({ data: card }: TapeCard): Record<string, unknown> {
  const leans = { bullish: 0, bearish: 0, mixed: 0, unclear: 0 };
  for (const story of card.stories) if (story.implication) leans[story.implication] += 1;
  const { long = 0, short = 0 } = card.positioning ?? {};
  return {
    asset: card.asset,
    price: card.price
      ? { now: card.price.now, weekChangePct: card.price.weekChangePct }
      : "no price history for it",
    stories: card.stories.length,
    leans,
    annotated: card.highlights.map(
      ({ storyId, label }) => label ?? card.stories.find((story) => story.id === storyId)?.title,
    ),
    positioning: card.positioning
      ? {
          ...card.positioning,
          longSharePct: long + short ? Math.round((long / (long + short)) * 100) : null,
        }
      : "unknown",
  };
}
