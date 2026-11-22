import { setTimeout as sleep } from "node:timers/promises";

import { theOwner } from "../../auth/owner.ts";
import {
  WatchRefused,
  type Source,
  type SourceBatch,
  type SourceFire,
  type SourceRun,
  type SourceWatch,
} from "../contract.ts";
import {
  clockConditionSchema,
  describe,
  nextAfter,
  onTheirClock,
  recurs,
  SCHEDULE_SHAPES,
  type ClockCondition,
} from "../../automations/schedule.ts";

const GUIDE = `The time: wakes you once at a moment, or again and again on a schedule, on the owner's own clock in their time zone; free, on this machine, to the second. A condition is one of:
- once: {"at":"2026-11-21 17:00"}
${SCHEDULE_SHAPES}
- every N hours from when it is set up: {"every":"4h"}, 1h to 24h
Times are 24-hour, "17:00" or "17:00:30", in the owner's time zone as their settings have it now, so 5pm stays 5pm through a change of the clocks and moves with them if they change zone. A schedule keeps firing by itself (leave repeat out); expires_in ends it, long enough to cover the last time they want. Start the description with when, in their words, "Every Friday at 5:00 pm: check the AI chips take"; the note says what to do then, exactly as they asked (when it is a routine, name it to load). Auni wakes only while it runs: a time missed while it was off is told once when it starts again, saying how late (a one-time watch however late; a schedule's only within 12 hours and before half the wait to its next time), and never as a backlog. The owner's brief is not a watch: set_notices moves it to any schedule above. For a price or news, use another source.`;

// The clock source: each watch's next time is worked out from its schedule, the owner's time
// zone and the last time it was told, which the cursor keeps. Nothing waits in memory for a time
// to come: each pass, about once a second, asks which times have passed, so a run started again
// after a restart or a sleep finds what it missed from the cursor alone. A fire's id is its
// watch and its time, so a time told twice (the cursor is saved only after the fire is recorded)
// is recorded once.
//
// A time missed while Auni was off (a laptop asleep at 5pm on Friday) is told once, late, when
// it starts again, never as a backlog. A one-time watch is told however late: it is the only
// time it has, and the agent, told how late, judges what is still worth doing. A schedule's is
// told only within LATE_FOR_MS and before half the wait to its next time, so a missed Friday is
// told on Friday evening, not on Saturday, and never just before the next.

/** How often a run asks which times have passed. */
const PASS_MS = 1_000;
/** Told within this long of its time, a fire is on time; any later, it says it is late. */
const ON_TIME_MS = 2 * 60_000;
/** The longest after its time that a schedule's missed time is still told. */
const LATE_FOR_MS = 12 * 3_600_000;

/** Where a watch stands: its condition when last read, and the last of its times told. */
interface Told {
  readonly condition: string;
  readonly through: number;
}

type Cursor = Record<string, Told>;

function readCursor(cursor: string | null): Cursor {
  try {
    const parsed: unknown = cursor ? JSON.parse(cursor) : {};
    return parsed && typeof parsed === "object" ? (parsed as Cursor) : {};
  } catch {
    return {};
  }
}

/** What a run reads the world through; tests give their own. */
export interface ClockWorld {
  now(): number;
  /** The owner's time zone as their settings have it now. */
  timeZone(): Promise<string>;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

const live: ClockWorld = {
  // Date.now(), which `auni demo` stands in for, so a demo's clock is this source's clock too.
  now: () => Date.now(),
  timeZone: async () => (await theOwner()).timeZone,
  wait: (ms, signal) => sleep(ms, undefined, { signal }).catch(() => undefined),
};

/** One pass: the fires due by `now`, moving each watch's place in `told` on. */
export function due(
  watches: readonly SourceWatch[],
  told: Cursor,
  zone: string,
  now: number,
): SourceFire[] {
  const fires: SourceFire[] = [];
  for (const watch of watches) {
    const parsed = clockConditionSchema.safeParse(watch.condition);
    if (!parsed.success) continue;
    const condition = parsed.data;
    const key = JSON.stringify(condition);
    const setUp = watch.since.getTime();
    const was = told[watch.id];
    // Counted on from its last time told; a watch first seen from when it was set up, and one
    // whose schedule was changed from now, so a changed time never fires for having passed.
    const through = !was ? setUp : was.condition === key ? was.through : now;
    let latest: number | null = null;
    let missed = 0;
    for (
      let next = nextAfter(condition, zone, through, setUp);
      next !== null && next <= now;
      next = nextAfter(condition, zone, next, setUp)
    ) {
      if (latest !== null) missed += 1;
      latest = next;
    }
    told[watch.id] = { condition: key, through: latest ?? through };
    if (latest === null || !worthTelling(condition, zone, latest, now, setUp)) continue;
    fires.push(fireOf(watch.id, condition, zone, latest, now, missed, setUp));
  }
  return fires;
}

/** Whether a time that passed is still told now; see the top of this file. */
function worthTelling(
  condition: ClockCondition,
  zone: string,
  time: number,
  now: number,
  setUp: number,
): boolean {
  const late = now - time;
  if (late <= ON_TIME_MS || !recurs(condition)) return true;
  const next = nextAfter(condition, zone, time, setUp)!;
  return late <= Math.min(LATE_FOR_MS, (next - time) / 2);
}

function fireOf(
  watchId: string,
  condition: ClockCondition,
  zone: string,
  time: number,
  now: number,
  missed: number,
  setUp: number,
): SourceFire {
  const late = now - time > ON_TIME_MS;
  const next = nextAfter(condition, zone, time, setUp);
  return {
    watchId,
    id: `${watchId}:${time}`,
    at: new Date(time),
    ...(late ? { late: true as const } : {}),
    report: {
      schedule: describe(condition),
      time: `${onTheirClock(time, zone)} (${zone})`,
      ...(late
        ? { late: `Auni was off then, and is telling it ${lateness(now - time)} late.` }
        : {}),
      ...(missed > 0 ? { earlierTimesMissed: missed } : {}),
      ...(next !== null ? { nextTime: onTheirClock(next, zone) } : {}),
    },
  };
}

/** "3 hours", "40 minutes", "2 days". */
function lateness(ms: number): string {
  const [unit, size] =
    ms >= 2 * 86_400_000
      ? ["days", 86_400_000]
      : ms >= 2 * 3_600_000
        ? ["hours", 3_600_000]
        : ["minutes", 60_000];
  return `${Math.round(ms / size)} ${unit}`;
}

/** The clock's run: a pass about once a second, a batch whenever a watch's place moved on. */
export async function* runClock(
  context: SourceRun,
  world: ClockWorld = live,
): AsyncGenerator<SourceBatch> {
  let told = readCursor(context.cursor);
  while (!context.signal.aborted) {
    const watches = context.watches();
    if (watches.length > 0) {
      const before = JSON.stringify(told);
      const fires = due(watches, told, await world.timeZone(), world.now());
      // Only the watches still watched are kept.
      told = Object.fromEntries(watches.flatMap(({ id }) => (told[id] ? [[id, told[id]]] : [])));
      const cursor = JSON.stringify(told);
      if (fires.length > 0 || cursor !== before) yield { fires, cursor };
    }
    await world.wait(PASS_MS, context.signal);
  }
}

export const clockSource: Source = {
  guide: GUIDE,
  condition: clockConditionSchema,
  // It needs nothing but this machine's clock.
  configured: () => true,
  // Each time was asked for: a reminder at 2:38 am is a promise, not news to weigh.
  alwaysWakes: true,
  recurs: (condition) => recurs(clockConditionSchema.parse(condition)),
  // A moment already past would never come, so it is refused with the owner's time now.
  async check(condition) {
    const parsed = clockConditionSchema.parse(condition);
    if (recurs(parsed)) return;
    const [zone, now] = [await live.timeZone(), live.now()];
    if (nextAfter(parsed, zone, now, now) === null)
      throw new WatchRefused(
        `That moment has passed: it is ${onTheirClock(now, zone)} on the owner's clock (${zone}).`,
      );
  },
  run: (context) => runClock(context),
};
