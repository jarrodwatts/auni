import { setTimeout as sleep } from "node:timers/promises";

import {
  WatchRefused,
  type RemoteWatchSpec,
  type Source,
  type SourceBatch,
  type SourceFire,
  type SourceRun,
  type SourceWatch,
} from "../contract.ts";
import { elfaConditionGroupSchema } from "./condition.ts";
import { BASE_URL, elfaKey, elfaRequest, ElfaError } from "./request.ts";
import { sseFrames } from "./sse.ts";
import { eventsById, storyFacts } from "./v3.ts";

// Elfa Auto keeps each watch as one of its queries, which Auni leases for at most 30 days and
// renews. A fire reaches Auni over Elfa's stream of every query's notifications, which Auni keeps
// open (run), and catches up on from each query when it opens again.

// Elfa's title and description caps; longer is a 400.
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 500;

const HOUR_MS = 60 * 60 * 1_000;
/** The fire waits on its story while it is read, so the read gives up early. */
const STORY_TIMEOUT_MS = 5_000;
/** Between reads of each query's fires when catching up: Elfa allows 60 requests a minute. */
const CATCH_UP_PACE_MS = 1_000;

// Elfa owns and validates the grammar; this is the part the agent needs to write it.
const GUIDE = `News, posts on X, sentiment and anything Elfa Auto can evaluate, checked by Elfa (elfa.ai) on Elfa credits. condition: {"AND":[...]} or {"OR":[...]}, groups nestable to depth 3, at most 10 leaves. Leaf: {"source","method","args","operator","value"}. Operators: > < >= <= == != crosses_above crosses_below (prefer crosses_* for levels).
- events: news about a subject, as Elfa writes it up from many posts (minutes to hours after the first), e.g. {"source":"events","args":{"entity":"ETH","implication":"bearish"}}. Args, at least one, each taking one value (for "BTC or ETH" write two leaves under OR): entity (ticker, name or Elfa id: "ETH", "Hyperliquid", "Michael Saylor"); entityType token|equity|project|person|organisation (always set it for a person or company, or "Elon Musk" resolves to a token named MUSK; Elfa files most companies, exchanges and labs as project and a listed company's stock as equity, so try organisation only when project finds nothing); eventType security|listing|regulatory|macro|protocol|company|marketFlow|price|social|other (a stock's earnings come as company); implication bullish|bearish|mixed|unclear; alertAction alert (judged impactful) or monitor; eventClass market|call; assetClass crypto|equity; novelty new|update; text plus minConfidence (start at 80) for a specific claim the story must state. Filters are free; text spends credits on every story it checks, so prefer filters ("bearish news on ETH" is entity+implication, never text) and add text only for a claim filters can't express. Central banks and macro themes aren't entities: {"eventType":"macro","text":"the Federal Reserve changes interest rates","minConfidence":80}. Each story wakes you once: later reports on it are recorded without waking you.
- tweet: {"source":"tweet","args":{"username":"elonmusk","text":"short factual claim, e.g. Posts about Dogecoin","minConfidence":80}} (monitored accounts only, no @).
- llm: {"source":"llm","method":"athena_condition","args":{"query":"fuzzy yes/no question about the world","period":"4h"}} (period >= 1h; every check spends credits, a 4h check over 30 days is ~900, so prefer 12h or 24h).
- price: method current|change(% over period)|high|low|volume; args {symbol, exchange:"hyperliquid"|"binance", period?}; ta: method rsi|macd_value|macd_signal|macd_histogram|bbands_upper|bbands_middle|bbands_lower|ema|sma|atr|stoch_k|stoch_d|cci|willr; args {symbol, timeframe:1m|5m|15m|30m|1h|2h|4h|8h|12h|1d, exchange, period? (required number for ema/sma)}. Use these to combine a price with news or indicators; a plain price level or move is cheaper on a prices source when one is installed.
- cron: {"source":"cron","method":"once","args":{"period":"24h"}} fires once that long after creation; method every repeats on that period; method schedule takes {"expression":"0 9 * * 5","timezone":"America/New_York"} (fixed minute, at most hourly). Never combine repeat with cron every/schedule (they recur already).
- Others: funding {ticker:"BTC:BINANCE"} method annualized_rate; liquidation {ticker} method total_usd_5m etc; fear_greed method value args {}; polymarket {ticker: outcome token id} method price; kalshi {ticker} method yes_price.`;

/** How long Elfa will watch for (expiresIn), shortest first; 720h is its longest. */
const DURATION_HOURS = [1, 2, 4, 8, 12, 24, 48, 72, 120, 168, 240, 336, 504, 720] as const;

/** Elfa's cooldowns between a repeating query's fires, shortest first. */
const COOLDOWNS = [
  ["0", 0],
  ["1m", 60_000],
  ["5m", 300_000],
  ["15m", 900_000],
  ["30m", 1_800_000],
  ["1h", HOUR_MS],
  ["2h", 2 * HOUR_MS],
  ["4h", 4 * HOUR_MS],
  ["8h", 8 * HOUR_MS],
  ["12h", 12 * HOUR_MS],
  ["24h", 24 * HOUR_MS],
  ["7d", 168 * HOUR_MS],
] as const;

/** Elfa's lifetime cap on a repeating query's fires; reaching it ends the query, which Auni renews. */
const MAX_TRIGGERS = 1_000;

function configured(): boolean {
  return elfaKey() !== undefined;
}

function request(
  path: string,
  init: { method?: string; body?: unknown; accept?: readonly number[] } = {},
): Promise<Record<string, unknown>> {
  return elfaRequest(`/v2/auto${path}`, init);
}

/** Where a watch's fires go: Elfa's stream, which a notify action reaches. */
function action(watchId: string) {
  return { stepId: "auni", type: "notify", params: { message: `Auni watch ${watchId}` } };
}

/** The shortest of Elfa's durations that covers the watch, at most its longest: the lease. */
export function leaseHours(expiresAt: Date | null, now = Date.now()): number {
  const wanted = expiresAt ? (expiresAt.getTime() - now) / HOUR_MS : Infinity;
  return DURATION_HOURS.find((hours) => hours >= wanted) ?? 720;
}

/** The longest of Elfa's cooldowns that is no longer than the watch's; Auni holds to the rest. */
export function elfaCooldown(cooldownMs: number): string {
  return COOLDOWNS.findLast(([, ms]) => ms <= cooldownMs)?.[0] ?? "0";
}

function issues(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((issue) =>
      typeof issue === "string"
        ? issue
        : issue && typeof issue === "object"
          ? JSON.stringify(issue)
          : String(issue),
    )
    .join("; ");
}

/** Validates, then creates and activates the query. Elfa requires the validate call first. */
async function watch(spec: RemoteWatchSpec): Promise<{ ref: string; until: Date }> {
  const hours = leaseHours(spec.expiresAt);
  const body = {
    query: {
      conditions: spec.condition,
      actions: [action(spec.id)],
      expiresIn: `${hours}h`,
      ...(spec.cooldownMs === null
        ? {}
        : { repeat: { cooldown: elfaCooldown(spec.cooldownMs), maxTriggers: MAX_TRIGGERS } }),
    },
    title: spec.description.slice(0, TITLE_MAX),
    description: spec.note.slice(0, DESCRIPTION_MAX),
  };
  const validation = await request("/queries/validate", {
    method: "POST",
    body,
    accept: [200, 400, 422],
  });
  if (validation.valid !== true) {
    const detail = issues(validation.errors) || JSON.stringify(validation).slice(0, 1_000);
    throw new WatchRefused(`Elfa rejected the condition: ${detail}`);
  }
  const created = await request("/queries", { method: "POST", body });
  const ref = created.queryId ?? created.id;
  if (typeof ref !== "string") throw new ElfaError("Elfa created a query without an id.");
  return { ref, until: new Date(Date.now() + hours * HOUR_MS) };
}

/** Cancels then deletes; either step already done is fine. */
async function unwatch(ref: string): Promise<void> {
  const id = encodeURIComponent(ref);
  await request(`/queries/${id}/cancel`, { method: "POST", accept: [200, 404, 409] });
  await request(`/queries/${id}`, { method: "DELETE", accept: [200, 204, 404, 409] });
}

/** One query as Elfa tells it now, free to read. A 404 or an odd answer throws. */
async function query(ref: string): Promise<{ status: string; executions: unknown[] }> {
  const body = await request(`/queries/${encodeURIComponent(ref)}`);
  if (body.queryId !== ref || typeof body.status !== "string") {
    throw new ElfaError(
      `Elfa answered for query ${ref} with ${JSON.stringify(body).slice(0, 500)}`,
    );
  }
  return {
    status: body.status,
    executions: Array.isArray(body.executions) ? body.executions : [],
  };
}

/** Still watching unless Elfa ended it: it fired its last, ran out its time, or failed it. */
async function watching(ref: string): Promise<boolean> {
  const { status } = await query(ref);
  return !["triggered", "expired", "failed", "cancelled"].includes(status);
}

/**
 * A fire as Auni records it: a news watch's story in full from Elfa's events (summary, sources,
 * how prices took it, its storyline), or the alert as Elfa told it when it isn't news or that
 * read fails, so a fire is never lost to it.
 */
async function elfaFire(
  watchId: string,
  id: string,
  payload: Record<string, unknown>,
  late: boolean,
): Promise<SourceFire> {
  const triggered = Date.parse(String(payload.triggerTime ?? ""));
  const base = {
    watchId,
    id,
    at: Number.isNaN(triggered) ? new Date() : new Date(triggered),
    ...(late ? { late: true as const } : {}),
  };
  const alert = {
    alert: [payload.title, payload.body].filter((part) => typeof part === "string").join(": "),
    trigger: payload.trigger,
  };
  const match = firedEventMatch(payload);
  if (!match) return { ...base, report: alert };
  try {
    const [event] = await eventsById([match.eventId], STORY_TIMEOUT_MS);
    if (event)
      return {
        ...base,
        report: storyFacts(event),
        ...(event.storylineId ? { story: event.storylineId } : {}),
      };
    console.error("elfa has no event", match.eventId, "for a fire; waking with the alert alone");
  } catch (error) {
    console.error("elfa event lookup failed; waking with the alert alone", error);
  }
  return { ...base, report: { ...alert, story: match } };
}

/**
 * The news event an `events` condition fired on, as Elfa names it under
 * trigger.matchedConditions: its id in /v3/events and the alert's title and classification.
 * Elfa evaluates conditions event by event, so a fire carries one.
 */
export function firedEventMatch(
  payload: Record<string, unknown>,
): (Record<string, unknown> & { readonly eventId: string }) | null {
  const trigger = payload.trigger as { matchedConditions?: unknown } | undefined;
  const matched = Array.isArray(trigger?.matchedConditions) ? trigger.matchedConditions : [];
  for (const entry of matched as { condition?: { source?: unknown }; match?: unknown }[]) {
    const match = entry?.match as Record<string, unknown> | undefined;
    if (entry?.condition?.source === "events" && typeof match?.eventId === "string") {
      return match as Record<string, unknown> & { eventId: string };
    }
  }
  return null;
}

function parsed(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Elfa's stream of every query's notifications on this key. It is live only, so each watch's fires
 * it may have missed are read from its query (the same ids as the stream's, so one told twice
 * counts once): once it's open, those since Auni last heard (or since the watch was set up, the
 * first time), and for a watch it sees first later on, those since that watch was set up. That
 * last catches a fire Elfa sent before Auni had stored its query's id. A query that isn't Auni's
 * (the owner's own, on the same key) is left alone.
 */
async function* run(context: SourceRun): AsyncGenerator<SourceBatch> {
  const response = await fetch(`${BASE_URL}/v2/auto/queries/stream`, {
    headers: { accept: "text/event-stream", "x-elfa-api-key": elfaKey() ?? "" },
    signal: context.signal,
  });
  // 410: no query is active, so there is nothing to hear until a watch starts one.
  if (response.status === 410 || response.status === 204) return;
  if (!response.ok || !response.body)
    throw new ElfaError(`Elfa's stream answered ${response.status}`);
  const checkedAt = new Date();
  /** The queries this run has read the fires of. */
  const caught = new Set<string>();
  function firstSeen(watches: readonly SourceWatch[]): SourceWatch[] {
    const fresh = watches.filter(({ ref }) => ref && !caught.has(ref));
    for (const { ref } of fresh) caught.add(ref!);
    return fresh;
  }
  const { since } = context;
  yield {
    fires: await caughtUp(
      firstSeen(context.watches()),
      (watch) => (since && since > watch.since ? since : watch.since),
      context.signal,
    ),
    cursor: checkedAt.toISOString(),
  };
  for await (const frame of sseFrames(response.body)) {
    if (frame.event === "end") return;
    if (frame.event === "error") throw new ElfaError(`Elfa's stream failed: ${frame.data}`);
    if (frame.event !== "notification") continue;
    const payload = parsed(frame.data);
    const executionId = payload?.executionId;
    if (!payload || payload.status !== "triggered" || typeof executionId !== "string") continue;
    // Read again now: a watch set up a moment ago can fire before the list Auni keeps holds it.
    const watches = await context.refresh();
    const watch = watches.find(({ ref }) => ref && ref === payload.queryId);
    const fires = watch ? [await elfaFire(watch.id, executionId, payload, false)] : [];
    const missed = await caughtUp(firstSeen(watches), (seen) => seen.since, context.signal);
    fires.push(...missed.filter(({ id }) => id !== executionId));
    // Not past a fire for a watch Auni can't place yet, so the next open still catches it up.
    if (fires.length > 0) yield { fires, cursor: new Date().toISOString() };
  }
}

/** Each watch's fires from its query's executions since `from(watch)`, as late. */
async function caughtUp(
  watches: readonly SourceWatch[],
  from: (watch: SourceWatch) => Date,
  signal: AbortSignal,
): Promise<SourceFire[]> {
  const fires: SourceFire[] = [];
  for (const [index, watch] of watches.entries()) {
    if (index > 0) await sleep(CATCH_UP_PACE_MS, undefined, { signal });
    const after = from(watch).getTime();
    const { executions } = await query(watch.ref!).catch((error: unknown) => {
      console.error(`elfa query ${watch.ref} not read to catch up`, error);
      return { executions: [] };
    });
    for (const execution of executions as Record<string, unknown>[]) {
      const at = Date.parse(String(execution.triggerTime ?? ""));
      if (typeof execution.id !== "string" || !(at > after)) continue;
      fires.push(await elfaFire(watch.id, execution.id, execution, true));
    }
  }
  return fires;
}

/** Elfa Auto: Elfa evaluates each condition, and tells Auni when one comes true. */
export const elfaSource: Source = {
  guide: GUIDE,
  condition: elfaConditionGroupSchema,
  configured,
  remote: { watch, unwatch, watching },
  run,
};
