import { storyImplicationSchema } from "./tape.schema.ts";
import { z } from "zod";

import { cached } from "../../money/swaps/shared.ts";
import { ELFA_BUSY, ElfaError, elfaKey, elfaRequest } from "./request.ts";

/**
 * Elfa's data API: what is happening (events), where attention is, and how
 * accounts are positioned. Read-only and free on Auni's key until 31 October
 * 2026, but it shares Auto's 60 requests a minute, so every read is cached
 * and time ranges are rounded so repeat reads hit the cache.
 */

const MINUTE_MS = 60_000;
const READ_TIMEOUT_MS = 10_000;
/** Time ranges start on this step, in seconds, so the same question asks the same thing. */
const RANGE_STEP_S = 300;
/** The agent's reads a minute, leaving the rest of the key's 60 to Auto and fired watches' story lookups. */
const READS_PER_MINUTE = 40;

export function elfaReadable(): boolean {
  return elfaKey() !== undefined;
}

const ENTITY_TYPES = ["token", "equity", "project", "person", "organisation"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

const entitySchema = z.object({
  id: z.string(),
  entityType: z.enum(ENTITY_TYPES),
  name: z.string().nullable(),
  symbol: z.string().nullish(),
  externalIds: z.object({ coingeckoId: z.string().nullish() }).nullish(),
});
export type ElfaEntity = z.infer<typeof entitySchema>;

const namedSchema = z.object({
  id: z.string(),
  symbol: z.string().nullish(),
  name: z.string().nullable(),
  entityType: z.string(),
});

const eventSchema = z.object({
  id: z.string(),
  eventClass: z.string(),
  alertTitle: z.string().nullable(),
  summary: z.string().nullable(),
  implication: storyImplicationSchema.nullable().catch(null),
  eventType: z.string().nullable(),
  primaryEntities: z.array(namedSchema).catch([]),
  alertAction: z.enum(["alert", "monitor"]).catch("monitor"),
  originCount: z.number().catch(0),
  impacts: z
    .array(
      z.object({
        entityId: z.string(),
        symbol: z.string().nullish(),
        priceChange1d: z.number().nullable(),
      }),
    )
    .catch([]),
  analyzedAt: z.number(),
  storylineId: z.string().nullable(),
  citedSources: z
    .array(
      z.object({ source: z.string(), handle: z.string().nullable(), link: z.string().nullable() }),
    )
    .catch([]),
});
export type ElfaEvent = z.infer<typeof eventSchema>;

const mindshareSchema = z.object({
  rank: z.number(),
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  share: z.number(),
  changePct: z.number().nullable(),
  hot: z.boolean().nullable(),
});
type ElfaMindshare = z.infer<typeof mindshareSchema>;

const positioningSchema = z.object({
  openLong: z.number(),
  openShort: z.number(),
  asOf: z.number(),
});
type ElfaPositioning = z.infer<typeof positioningSchema>;

type Params = Readonly<Record<string, string | number | undefined>>;

function v3Path(endpoint: string, params: Params): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value));
  }
  return `/v3/${endpoint}?${query}`;
}

const recentReads: number[] = [];

/** The agent's reads, within READS_PER_MINUTE, so a turn that asks about everything can't spend the key. */
function get(path: string) {
  const now = Date.now();
  while (recentReads.length && now - recentReads[0]! >= MINUTE_MS) recentReads.shift();
  if (recentReads.length >= READS_PER_MINUTE) return Promise.reject(new ElfaError(ELFA_BUSY));
  recentReads.push(now);
  return elfaRequest(path, { timeoutMs: READ_TIMEOUT_MS });
}

// Keyed by the request's path, so one cache serves every endpoint.
const fresh = cached(5 * MINUTE_MS, (path) => get(path));
// An entity's id never changes, so a resolved name holds for a day.
const lasting = cached(24 * 60 * MINUTE_MS, (path) => get(path));

/** The entries of a list that read as expected; one Elfa changed the shape of is dropped, not the whole answer. */
function each<T>(schema: z.ZodType<T>, list: unknown): T[] {
  return (Array.isArray(list) ? list : []).flatMap((item) => {
    const parsed = schema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Unix seconds `days` ago, on the range step. */
export function daysAgo(days: number, now = Date.now()): number {
  const seconds = Math.floor(now / 1_000) - days * 86_400;
  return seconds - (seconds % RANGE_STEP_S);
}

/**
 * The best match for a ticker, $cashtag, name, @handle, address or CoinGecko
 * id, or null. Elfa matches exactly, so a prefix or a misspelling finds nothing.
 */
export async function resolveEntity(
  query: string,
  types?: readonly EntityType[],
): Promise<ElfaEntity | null> {
  const body = await lasting(
    v3Path("entities", { q: query.trim(), entityType: types?.join(","), limit: 1 }),
  );
  return each(entitySchema, body.entities)[0] ?? null;
}

/**
 * GET /v3/events, newest first. Elfa refuses some combinations (sort=relevant
 * takes no range, q no assetClass); the caller sends only what goes together.
 */
export async function findEvents(params: {
  readonly entityIds?: string;
  readonly q?: string;
  readonly from?: number;
  readonly sort?: "relevant";
  readonly assetClass?: "crypto" | "equity";
  readonly alertAction?: "alert" | "monitor";
  readonly limit?: number;
}): Promise<ElfaEvent[]> {
  const body = await fresh(v3Path("events", params));
  return each(eventSchema, body.events);
}

/**
 * Events by id as Elfa tells them now; an id it doesn't hold is left out.
 * A fired watch reads its story here, outside the agent's budget, so a busy turn
 * can't make it wake the thread twice for one story.
 */
export async function eventsById(
  ids: readonly string[],
  timeoutMs = READ_TIMEOUT_MS,
): Promise<ElfaEvent[]> {
  const body = await elfaRequest(v3Path("events", { eventIds: ids.join(",") }), { timeoutMs });
  return each(eventSchema, body.events);
}

/** Assets ranked by their share of a market's attention over the period. */
export async function mindshare(params: {
  readonly market: "crypto" | "equity";
  readonly period: "1h" | "4h" | "24h" | "7d";
  readonly limit: number;
}): Promise<ElfaMindshare[]> {
  const body = await fresh(
    v3Path(`market/${params.market}/mindshare`, { period: params.period, limit: params.limit }),
  );
  return each(mindshareSchema, body.assets);
}

/** Open long and short calls on one token or stock, now. */
export async function positioning(entityId: string): Promise<ElfaPositioning | null> {
  const parsed = positioningSchema.safeParse(
    await fresh(v3Path("calls/positioning", { entityId })),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * The news, each story once. Calls are traders taking positions, not news, so
 * they go first, before one can stand in for its storyline. Later reports on
 * a story come as further events with its storylineId, so only the first of
 * each is kept. An event in no storyline is its own story.
 */
export function oncePerStory(events: readonly ElfaEvent[]): ElfaEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (event.eventClass === "call") return false;
    if (!event.storylineId) return true;
    if (seen.has(event.storylineId)) return false;
    seen.add(event.storylineId);
    return true;
  });
}

/** Elfa's fraction (0.0157) as a percent rounded for reading (1.57). */
export function percent(fraction: number): number {
  return Math.round(fraction * 10_000) / 100;
}

/** An event as the agent reads it: what happened, which way it leans, when, who reported it, and how prices took it. */
export function storyFacts(event: ElfaEvent) {
  return {
    // What market_pulse is told to annotate a story by.
    id: event.id,
    title: event.alertTitle,
    summary: event.summary,
    about: event.primaryEntities.map((entity) => entity.symbol ?? entity.name).filter(Boolean),
    implication: event.implication,
    eventType: event.eventType,
    at: new Date(event.analyzedAt * 1_000).toISOString(),
    sourceCount: event.originCount,
    sources: event.citedSources.flatMap((source) => (source.link ? [source.link] : [])).slice(0, 5),
    // The day after the first post, per asset; empty on most events.
    priceReaction: event.impacts.flatMap((impact) =>
      impact.priceChange1d === null
        ? []
        : [{ symbol: impact.symbol ?? null, dayChangePct: percent(impact.priceChange1d) }],
    ),
  };
}
