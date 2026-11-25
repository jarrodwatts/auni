import { existsSync } from "node:fs";
import { platform } from "node:os";

import type { AppAbout, BrainModelWire } from "@auni/shared";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";

import { settingsFile } from "../data-dir.ts";
import { databaseFiles } from "../db/client.ts";
import { env } from "../env.ts";
import { onSettingsChange } from "../settings.ts";
import type { Brain, BrainCheck, BrainEvent, BrainNotReady, BrainTurn } from "../apps/contract.ts";
import { brains } from "../apps/registry.ts";
import { theBox, type Box } from "./box.ts";
import { translate } from "./translate.ts";

/** Checking a CLI's login spawns it, so a ready answer holds for a while. */
const READY_HOLDS_MS = 5 * 60_000;
/**
 * A not-ready answer holds briefly: a fresh login is seen within half a minute, yet a brain that
 * stays logged out isn't spawned again on every turn and every Settings read.
 */
const NOT_READY_HOLDS_MS = 30_000;
/** A CLI that hangs (an update prompt, a keychain) must not hang every turn with it. */
const CHECK_LIMIT_MS = 20_000;
/** The one tiny question that proves a login: a fast model's one word, on top of starting. */
const QUESTION_LIMIT_MS = 30_000;
/**
 * A CLI that didn't answer holds as long as a ready one: each try costs whoever asks (a turn,
 * triage, Settings) the whole limit, and it likely still waits on the same prompt.
 */
const HUNG_HOLDS_MS = READY_HOLDS_MS;

/**
 * Each brain's latest check: one still running (no `answeredAt` yet) is shared by everyone who
 * asks meanwhile. `retryable` marks a not-ready answer a fresh login could change at once.
 */
interface Held {
  readonly check: Promise<BrainCheck>;
  /** What the check itself saw, before a running Auni proved the login (see proven). */
  readonly seen: Promise<BrainCheck>;
  readonly answeredAt?: number;
  readonly holdsMs?: number;
  readonly retryable?: boolean;
}
const checks = new Map<string, Held>();

/** Who waits to hear that a brain's check has come back ready (onBrainReady). */
const readyListeners = new Set<() => void>();

/**
 * Calls `listener` each time a brain's check comes back ready (proven, in a running Auni): as
 * `auni` tells the terminal, once the owner signs one in from the browser. Returns its removal.
 */
export function onBrainReady(listener: () => void): () => void {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
}

/**
 * A brain's check, held as long as its answer holds. `notReadyFreshMs` asks again sooner after a
 * not-ready answer, for a screen waiting on the owner's login, while everyone else (turns,
 * triage) keeps the half-minute hold.
 */
function checked(id: string, brain: Brain, notReadyFreshMs?: number): Promise<BrainCheck> {
  const held = checks.get(id);
  if (held) {
    if (held.answeredAt === undefined) return held.check;
    const holdsMs =
      held.retryable && notReadyFreshMs !== undefined
        ? Math.min(held.holdsMs!, notReadyFreshMs)
        : held.holdsMs!;
    if (Date.now() < held.answeredAt + holdsMs) return held.check;
  }
  const stop = new AbortController();
  // setTimeout rather than AbortSignal.timeout, so tests can drive it with fake timers.
  const timer = setTimeout(() => stop.abort(), CHECK_LIMIT_MS);
  // The check's own answer, before any proof: the first answer given wins.
  let saw: (answer: BrainCheck) => void = () => {};
  const seen = new Promise<BrainCheck>((resolve) => (saw = resolve));
  const answered = new Promise<{ answer: BrainCheck; holdsMs: number }>((resolve) => {
    const done = (answer: BrainCheck, holdsMs: number) => {
      saw(answer);
      resolve({ answer, holdsMs });
    };
    stop.signal.addEventListener(
      "abort",
      () =>
        done(
          {
            ready: false,
            why: "broken",
            fix: `it didn't answer within ${CHECK_LIMIT_MS / 1000} seconds, so run it in a terminal to see what it waits on`,
          },
          HUNG_HOLDS_MS,
        ),
      { once: true },
    );
    brain
      .check(stop.signal)
      .then((answer) => {
        // The question has its own limit: a CLI that answered has started.
        clearTimeout(timer);
        saw(answer);
        return answer.ready && provesLogins ? proven(id, brain, answer) : answer;
      })
      .then(
        (answer) => done(answer, answer.ready ? READY_HOLDS_MS : NOT_READY_HOLDS_MS),
        (error: unknown) =>
          done(
            {
              ready: false,
              why: "broken",
              fix: error instanceof Error ? error.message : String(error),
            },
            NOT_READY_HOLDS_MS,
          ),
      );
  }).finally(() => clearTimeout(timer));
  const check = answered.then(({ answer }) => answer);
  checks.set(id, { check, seen });
  void answered.then(({ answer, holdsMs }) => {
    checks.set(id, {
      check,
      seen,
      answeredAt: Date.now(),
      holdsMs,
      retryable: !answer.ready && holdsMs === NOT_READY_HOLDS_MS,
    });
    if (answer.ready) for (const listener of readyListeners) listener();
  });
  return check;
}

/**
 * Whether this process asks a brain's model before calling it ready. A check only sees that a
 * login is there, and a key that's there may still be refused, so the running Auni (`start.ts`)
 * asks a brain that checks ready one tiny question: once, and again after a turn's login is
 * refused. A one-off command (`auni doctor`, `auni setup`, run again and again by a coding agent)
 * never calls a model, and says what the check sees.
 */
let provesLogins = false;

/** This process is Auni itself: prove each login before calling it ready. */
export function proveLogins(): void {
  provesLogins = true;
}

/** Brains whose login a model answered in this process. */
const answered = new WeakSet<Brain>();

/** `ready`, once the brain's login has answered one question; else what check should have said. */
async function proven(id: string, brain: Brain, ready: BrainCheck): Promise<BrainCheck> {
  if (answered.has(brain)) return ready;
  const turn: BrainTurn = {
    systemPrompt: "Answer with one word.",
    prompt: ["Say ok."],
    role: "fast",
    mcp: null,
    box: await brainBox(),
  };
  try {
    for await (const event of brain.run(turn, AbortSignal.timeout(QUESTION_LIMIT_MS))) {
      if (event.type === "refused") return { ready: false, why: event.why, fix: event.fix };
      // At its limit, the login still answered.
      if (event.type === "limit") rest(id, event.resetsAt);
      if (event.type === "limit" || event.type === "done") answered.add(brain);
    }
  } catch {
    // Below: as any other failure.
  }
  // Any other failure (no network, say) can't tell: it is asked again with the next check.
  return ready;
}

/**
 * Forgets what was known of a brain's login and checks it again now, after a sign-in or an
 * install from the web app changed it (agent/sign-in.ts): a running Auni proves it again too.
 */
export function checkAfresh(id: string): Promise<BrainCheck> {
  const found = brains().find(({ about }) => about.id === id);
  if (!found) throw new Error(`${id} is no brain app`);
  checks.delete(id);
  answered.delete(found.brain);
  return checked(id, found.brain);
}

/** A turn's login was refused: the brain shows as `check` should have said until it's proven. */
function refuse(
  { about, brain }: Pick<PickedBrain, "about" | "brain">,
  { why, fix }: Extract<BrainEvent, { type: "refused" }>,
): void {
  answered.delete(brain);
  const refused = Promise.resolve<BrainCheck>({ ready: false, why, fix });
  checks.set(about.id, {
    check: refused,
    seen: refused,
    answeredAt: Date.now(),
    holdsMs: NOT_READY_HOLDS_MS,
    retryable: true,
  });
}

interface PickedBrain {
  readonly about: AppAbout;
  readonly brain: Brain;
  /** The credential it thinks on, as the owner knows it. */
  readonly login: string;
}

/** Brains whose plan ran out, until it comes back. In memory: a restart costs one more try. */
const resting = new Map<string, Date>();
/** How long a brain rests when its CLI didn't say when its limit resets. */
const REST_MS = 60 * 60_000;

function rest(id: string, resetsAt: Date | null): void {
  resting.set(id, resetsAt ?? new Date(Date.now() + REST_MS));
}

const isResting = (id: string) => (resting.get(id)?.getTime() ?? 0) > Date.now();

/** When a brain at its usage limit can think again; null for one that isn't resting. */
export function restingUntil(id: string): Date | null {
  return isResting(id) ? resting.get(id)! : null;
}

/** What Windows needs: Auni, and every step of setting it up, inside WSL's Linux. */
export const ON_WINDOWS =
  "Auni runs on Linux and macOS. On Windows, run it inside WSL: `wsl --install` in PowerShell " +
  "(restart if it asks), then open the Ubuntu terminal it adds and set Auni up there, from the start.";

/** The owner's preferred brain id (`BRAIN`), or null for automatic order. */
export function preferredBrainId(): string | null {
  return env.BRAIN?.trim() || null;
}

onSettingsChange((name) => {
  if (name === "BRAIN") env.BRAIN = process.env.BRAIN?.trim() || undefined;
});

/**
 * Why no brain can think on this machine whatever the owner logs in to, or null: Windows, where
 * the box (built on Linux's and macOS's sandboxes) can't run, or a BRAIN naming no brain app.
 */
export function brainsBlocked(): string | null {
  if (platform() === "win32") return ON_WINDOWS;
  const preferred = preferredBrainId();
  if (preferred && !brains().some(({ about }) => about.id === preferred))
    return `BRAIN=${preferred} names no brain app: change it in ${settingsFile()}, or remove it.`;
  return null;
}

/** No brain can think yet: what the owner runs to make each ready. */
export interface NoBrain {
  readonly fixes: readonly string[];
  /** Nothing in Auni can make one ready: BRAIN names no brain app, or the box can't run here. */
  readonly blocked?: true;
}

/** The brains in the order a turn asks them: `preferred` first if given, then BRAIN, then order.ts. */
function inTurn(preferred?: string): ReturnType<typeof brains> {
  const all = brains();
  const fallback = preferredBrainId();
  return all.toSorted((a, b) => {
    if (preferred) {
      const pref = Number(b.about.id === preferred) - Number(a.about.id === preferred);
      if (pref !== 0) return pref;
    }
    return Number(b.about.id === fallback) - Number(a.about.id === fallback);
  });
}

/**
 * The rule for which brain answers, in one sentence the owner reads in `auni doctor` and in a
 * brain's sheet; null with only one brain to pick from. `settingsFile` is where BRAIN is set.
 */
export function whichBrainSays(settingsFile: string): string | null {
  const names = inTurn().map(({ about }) => about.name);
  if (names.length < 2) return null;
  const order = `${names.slice(0, -1).join(", ")}, then ${names.at(-1)}`;
  return preferredBrainId()
    ? `Auni asks ${order}, as BRAIN in ${settingsFile} says, and thinks with the first that is ready.`
    : `Auni asks ${order}, and thinks with the first that is ready. You can also pick a model right in any thread.`;
}

/**
 * The brain this turn thinks with: `preferred` first if ready, then the first that is ready on
 * this machine in the order whichBrainSays tells the owner. One at its usage limit waits behind
 * any other that is ready; with none, it's tried anyway, since its CLI knows best whether the
 * limit has lifted. With no brain ready, what the owner can run to make each ready.
 */
export async function pickBrain(preferred?: string): Promise<PickedBrain | NoBrain> {
  const picked = await pick(checked, preferred);
  if ("about" in picked) return picked;
  if ("blocked" in picked) return { fixes: [picked.blocked], blocked: true };
  return {
    fixes: picked.unavailable.map(({ name, id, state, fix }) => fixLine({ name, id }, state, fix)),
  };
}

/**
 * The brain pickBrain would pick by what each check sees, without waiting on a running Auni's
 * proof that its login answers (a model's one word, seconds more): what `auni` says it thinks
 * with as it starts, while the proof goes on for the first turn.
 */
export async function brainSeen(auni: string): Promise<{ name: string | null; line: string }> {
  const picked = await pick((id, brain) => {
    void checked(id, brain);
    return checks.get(id)!.seen;
  });
  const until = "about" in picked ? restingUntil(picked.about.id) : null;
  const row: TerminalBrain | undefined =
    "about" in picked
      ? { ...picked.about, ...(until ? { state: "resting", until } : { state: "ready" }) }
      : "unavailable" in picked
        ? picked.unavailable[0]
        : undefined;
  return {
    name: "about" in picked ? terminalName(picked.about) : null,
    line: terminalBrainLine(row, "blocked" in picked ? picked.blocked : null, auni),
  };
}

type UnavailableBrain = Extract<BrainRow, { fix: string }>;

async function pick(
  look: (id: string, brain: Brain) => Promise<BrainCheck>,
  preferred?: string,
): Promise<PickedBrain | { blocked: string } | { unavailable: UnavailableBrain[] }> {
  const blocked = brainsBlocked();
  if (blocked) return { blocked };
  const unavailable: UnavailableBrain[] = [];
  let tired: PickedBrain | undefined;
  for (const { about, brain } of inTurn(preferred)) {
    const check = await look(about.id, brain);
    if (!check.ready) {
      unavailable.push({ id: about.id, name: about.name, state: check.why, fix: check.fix });
      continue;
    }
    const picked = { about, brain, login: check.login };
    if (!isResting(about.id)) return picked;
    tired ??= picked;
  }
  return tired ?? { unavailable };
}

export type BrainStatus =
  | {
      readonly ready: true;
      readonly name: string;
      readonly login: string;
      /** It is at its usage limit until then, with no other brain ready to answer meanwhile. */
      readonly restingUntil?: Date;
    }
  | ({ readonly ready: false } & NoBrain);

/** Which brain turns think with, on what login, as setup, doctor, boot and Settings say it. */
export async function brainStatus(): Promise<BrainStatus> {
  const picked = await pickBrain();
  if (!("about" in picked)) return { ready: false, ...picked };
  const until = restingUntil(picked.about.id);
  return {
    ready: true,
    name: picked.about.name,
    login: picked.login,
    ...(until ? { restingUntil: until } : {}),
  };
}

/** One brain app as setup and the model picker show it: ready (or resting at its limit), or why not. */
export type BrainRow = { readonly id: string; readonly name: string } & (
  | {
      readonly state: "ready";
      readonly login: string;
      readonly signedInAs?: string;
      readonly models: readonly BrainModelWire[];
    }
  | {
      readonly state: "resting";
      readonly login: string;
      readonly signedInAs?: string;
      readonly models: readonly BrainModelWire[];
      readonly until: Date;
    }
  | { readonly state: BrainNotReady; readonly fix: string }
);

const terminalName = ({ id, name }: Named) =>
  brains().find(({ about }) => about.id === id)?.brain.terminalName ?? name;
type TerminalBrain = Named &
  ({ state: "ready" } | { state: "resting"; until: Date } | UnavailableBrain);

/** The terminal names only the brain Auni picked, or the first one it would try. */
export function terminalBrainLine(
  row: TerminalBrain | undefined,
  blocked: string | null,
  auni: string,
): string {
  if (blocked === ON_WINDOWS) return "Auni needs Linux on Windows. Run: wsl --install";
  if (blocked)
    return `Auni can't use the AI named in ${settingsFile()}. Pick an installed AI there and try again.`;
  if (!row) return `Couldn't check your AI. Run: ${auni} doctor --verbose`;
  const name = terminalName(row);
  switch (row.state) {
    case "ready":
      return `${name} is ready.`;
    case "resting":
      return `${name} has reached its usage limit until ${row.until.toLocaleString()}.`;
    case "signed-out":
      return `${name} isn't signed in. Run: ${row.fix}`;
    case "expired":
      return `${name}'s sign-in expired. Run: ${row.fix}`;
    case "not-installed":
      return `${name} needs to be set up. Run: ${row.fix}`;
    case "broken":
      return `Couldn't check ${name}. Run: ${auni} doctor --verbose`;
  }
}

/**
 * Every brain app, in the order a turn asks them, as it stands on this machine. `notReadyFreshMs` asks a
 * not-ready brain again that soon, so a screen waiting on a login sees it within seconds.
 */
export async function brainRows(
  options: { readonly notReadyFreshMs?: number } = {},
): Promise<BrainRow[]> {
  return Promise.all(
    inTurn().map(async ({ about, brain }): Promise<BrainRow> => {
      const check = await checked(about.id, brain, options.notReadyFreshMs);
      const named = { id: about.id, name: about.name };
      if (!check.ready) return { ...named, state: check.why, fix: check.fix };
      const ready = {
        ...named,
        login: check.login,
        ...(check.signedInAs ? { signedInAs: check.signedInAs } : {}),
        models: check.models ?? [],
      };
      const until = restingUntil(about.id);
      return until ? { ...ready, state: "resting", until } : { ...ready, state: "ready" };
    }),
  );
}

/**
 * What the web app does for a brain that can't think, from any of the owner's devices: its CLI's
 * own sign-in, or installing its CLI in Auni's tools folder (agent/sign-in.ts); null where only
 * the owner can, at the machine Auni runs on (a sandbox that takes sudo, say).
 */
export function fromTheApp(id: string, why: BrainNotReady): "sign-in" | "install" | null {
  const brain = brains().find(({ about }) => about.id === id)?.brain;
  if ((why === "signed-out" || why === "expired") && brain?.signIn) return "sign-in";
  if (why === "not-installed" && brain?.install) return "install";
  return null;
}

/** How the owner fixes a brain: in the app where it can, else `fix` itself, a command or why. */
function howToFix({ id }: Named, why: BrainNotReady, fix: string): string {
  const app = fromTheApp(id, why);
  if (!app) return fix;
  const does = app === "sign-in" ? "sign it in" : "install it";
  return `${does} from Settings → AI Brains, on any of your devices (or run \`${fix}\` where Auni runs)`;
}

interface Named {
  readonly id: string;
  readonly name: string;
}

/** What the owner reads when a brain's login was refused mid-turn, and how to fix it. */
export function refusedNotice(
  brain: Named,
  { why, fix }: NonNullable<TurnResult["refused"]>,
): string {
  const refused = { "signed-out": "its login was refused", expired: "its sign-in has expired" };
  if (why !== "signed-out" && why !== "expired") return `${brain.name} couldn't answer. ${fix}.`;
  const how = fromTheApp(brain.id, why)
    ? howToFix(brain, why, fix)
    : `where Auni runs, run \`${fix}\``;
  return `${brain.name} couldn't answer: ${refused[why]}. ${how[0]!.toUpperCase()}${how.slice(1)}, then ask again.`;
}

/**
 * A brain that can't think, as one line of how the owner makes it ready: "Codex: sign it in from
 * Apps, on Codex's sheet, ...", saying first when the sign-in it keeps has expired, which the
 * fix alone would leave them to guess.
 */
export function fixLine(brain: Named, why: BrainNotReady, fix: string): string {
  const how = howToFix(brain, why, fix);
  return why === "expired"
    ? `${brain.name}'s sign-in has expired: ${how}`
    : `${brain.name}: ${how}`;
}

/** What the owner reads, in a thread and at boot, when no brain can think yet. */
export function nothingToThinkWith(fixes: readonly string[]): string {
  return `Auni has nothing to think with yet. Any one of these makes it ready:\n\n${fixes.map((fix) => `- ${fix}`).join("\n")}`;
}

/** "3:40 PM", or "Monday 3:40 PM" when that's more than most of a day away. */
function resetTime(at: Date, timeZone: string): string {
  const soon = at.getTime() - Date.now() < 20 * 60 * 60_000;
  return at.toLocaleString("en-US", {
    timeZone,
    ...(soon ? {} : { weekday: "long" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * What the owner reads when a brain's plan ran out mid-turn: until when, and what answers their
 * next message. The brain rests by then, so another that's ready comes first.
 */
export async function limitNotice(
  picked: PickedBrain,
  resetsAt: Date | null,
  timeZone: string,
): Promise<string> {
  const until = resetsAt ? ` until ${resetTime(resetsAt, timeZone)}` : "";
  const next = await pickBrain();
  const then =
    "about" in next && next.about.id !== picked.about.id
      ? `Your next message will use ${next.about.name}.`
      : `Auni can answer again ${resetsAt ? "then" : "once it resets"}.`;
  return `${picked.about.name} has reached its usage limit${until}. ${then}`;
}

/**
 * Every brain's box hides every brain's login, so one CLI never reads another's, and the
 * database's own files when they are on this machine.
 */
export async function brainBox(): Promise<Box> {
  const database = await databaseFiles();
  return theBox([
    ...brains().flatMap(({ brain }) => brain.secrets()),
    ...(database && existsSync(database) ? [database] : []),
  ]);
}

interface TurnRun {
  readonly picked: PickedBrain;
  readonly turn: BrainTurn;
  readonly messageId: string;
  readonly metadata: unknown;
  readonly signal: AbortSignal;
  /** Each chunk as it comes; the stream waits for one that returns a promise. */
  readonly onChunk: (chunk: UIMessageChunk) => void | Promise<void>;
  /** The answer as it stands, after each chunk that changed it. */
  readonly onMessage?: (message: UIMessage) => void;
  /** The brain's CLI is up and thinking. */
  readonly onReady?: (ready: Extract<BrainEvent, { type: "ready" }>) => void;
}

export interface TurnResult {
  readonly message: UIMessage;
  readonly stopped: boolean;
  /** Set when the turn ended without finishing. */
  readonly error?: string;
  /** The model and credential the brain said it used. */
  readonly model?: string;
  readonly login?: string;
  /** The owner's plan ran out mid-turn; when it comes back, if the CLI said. */
  readonly limit?: { readonly resetsAt: Date | null };
  /** Its login was refused: why it can't think, and what the owner runs. */
  readonly refused?: { readonly why: BrainNotReady; readonly fix: string };
}

/**
 * Runs one turn on the picked brain, streaming the web's chunks as they come and returning the
 * whole answer. A usage limit rests the brain, so the next turn picks another if one is ready.
 */
export async function runTurn(run: TurnRun): Promise<TurnResult> {
  const outcome: {
    error?: string;
    model?: string;
    login?: string;
    limit?: { resetsAt: Date | null };
    refused?: TurnResult["refused"];
  } = {};
  async function* watched(): AsyncIterable<BrainEvent> {
    for await (const event of run.picked.brain.run(run.turn, run.signal)) {
      if (event.type === "ready") {
        outcome.model = event.model;
        outcome.login = event.login;
        run.onReady?.(event);
      }
      if (event.type === "limit") {
        outcome.limit = { resetsAt: event.resetsAt };
        rest(run.picked.about.id, event.resetsAt);
      }
      if (event.type === "refused") {
        outcome.refused = { why: event.why, fix: event.fix };
        refuse(run.picked, event);
      }
      if (event.type === "error") outcome.error = event.message;
      yield event;
    }
  }
  async function* published(): AsyncIterable<UIMessageChunk> {
    for await (const chunk of translate(watched(), {
      messageId: run.messageId,
      metadata: run.metadata,
    })) {
      await run.onChunk(chunk);
      yield chunk;
    }
  }

  let message: UIMessage = { id: run.messageId, role: "assistant", parts: [] };
  try {
    for await (const next of readUIMessageStream({ stream: toReadableStream(published()) })) {
      message = next;
      run.onMessage?.(message);
    }
  } catch (error) {
    outcome.error ??= error instanceof Error ? error.message : String(error);
  }
  const stopped = run.signal.aborted;
  return {
    message: { ...message, id: run.messageId },
    stopped,
    ...(stopped ? {} : outcome.error ? { error: outcome.error } : {}),
    ...(outcome.model ? { model: outcome.model } : {}),
    ...(outcome.login ? { login: outcome.login } : {}),
    ...(outcome.limit ? { limit: outcome.limit } : {}),
    ...(outcome.refused ? { refused: outcome.refused } : {}),
  };
}

/**
 * One answer with no tools, as the object `turn.outputSchema` describes; throws when the brain
 * doesn't give one.
 */
export async function think(
  picked: PickedBrain,
  turn: BrainTurn,
  signal: AbortSignal,
): Promise<unknown> {
  for await (const event of picked.brain.run(turn, signal)) {
    if (event.type === "done") return event.output;
    if (event.type === "refused") refuse(picked, event);
    if (event.type === "error") throw new Error(event.message);
    if (event.type === "limit") {
      rest(picked.about.id, event.resetsAt);
      throw new Error(`${picked.about.name} is at its usage limit`);
    }
  }
  throw new Error(signal.aborted ? "stopped" : "the brain stopped before it answered");
}

/**
 * One quick answer with no tools, as `turn.outputSchema` describes: the picked brain's fast
 * model, in its box. With no brain ready, what the owner runs instead.
 */
export async function askFast(
  turn: Pick<BrainTurn, "systemPrompt" | "prompt" | "outputSchema">,
  timeoutMs: number,
): Promise<{ readonly output: unknown } | NoBrain> {
  const picked = await pickBrain();
  if (!("about" in picked)) return picked;
  const output = await think(
    picked,
    { ...turn, role: "fast", mcp: null, box: await brainBox() },
    AbortSignal.timeout(timeoutMs),
  );
  return { output };
}

function toReadableStream<T>(iterable: AsyncIterable<T>): ReadableStream<T> {
  const iterator = iterable[Symbol.asyncIterator]();
  return new ReadableStream<T>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}
