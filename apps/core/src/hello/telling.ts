import { closeSync, openSync, writeSync } from "node:fs";
import { Worker } from "node:worker_threads";

import { auniLog } from "../data-dir.ts";
import { SCENE_ROWS, SCENE_WIDTH, type ColorMode } from "./scene.ts";
import type { BrainFound } from "./stage.ts";
import type { StageStart, ToStage } from "./stage-worker.ts";
import { toTerminal } from "./terminal.ts";

// How `auni` tells the owner it is starting. In a terminal with room for it, a small Auni hops
// across three stones as each thing really comes up (stage.ts): its memory (the database), its
// brain (your AI) and your page (the web app), then leaps off the terminal into the browser, which
// opens the moment the page is ready: Auni's goodbye plays while the browser takes its moment to
// come up, so the owner never waits on it. Anywhere else (a pipe, a coding agent's shell, a
// service's log, TERM=dumb) it is plain lines: Auni's own, never the web app's.
//
// The scene plays on a thread of its own (stage-worker.ts), so it never freezes while Auni's own
// thread loads the rest of core. While it plays it owns the terminal: whatever else is printed
// waits. Once Auni is up the terminal stays the owner's, with the stones and what to know, and
// Auni's own working lines go to its log (auni.log in the data folder), the one a service or a
// background Auni writes; when it stops, fails to start, or has to wait on something outside it,
// the scene is cleared away and the terminal gets what was held, then plain lines.

export interface Telling {
  /** A line about where Auni is or what to run: printed, or kept under the scene's stones. */
  say(line: string): void;
  /** A line the scene already shows in its own way: printed only without it. */
  log(line: string): void;
  /**
   * Auni is held up by something outside it (another auni command holding its database): said at
   * once, with the scene cleared away, so the owner isn't left watching it wait with no reason.
   */
  waiting(line: string): void;
  /** The database answers. Told once Auni's own Postgres is up, and again once migrated. */
  memoryReady(): void;
  /** Whether the owner has yet to send their first take: the hop plays in full while it's ahead. */
  firstRun(ahead: boolean): void;
  /** The web app is being built, which the first time takes a minute. */
  pageBuilding(): void;
  pageReady(): void;
  /** What Auni thinks with: told as it starts, and again if the owner signs one in later. */
  brain(found: BrainFound): void;
  /** The browser is opening: Auni says goodbye and leaps off the terminal into it. */
  leaving(): void;
  /** Auni is up: the browser opened on it, or couldn't. */
  up(opened: boolean): void;
  /**
   * Gives the terminal back for what Auni says next, as it stops or fails to start: a scene still
   * playing is cleared away, since what went wrong reads better on its own.
   */
  abandon(): void;
}

/** Plain lines: what `auni` prints where no scene plays. */
export function plainTelling(print: (line: string) => void): Telling {
  let memory = false;
  return {
    say: print,
    log: print,
    waiting: print,
    memoryReady: () => {
      if (!memory) print("Memory ready.");
      memory = true;
    },
    firstRun: () => {},
    pageBuilding: () => print("Building the web app."),
    pageReady: () => {},
    brain: ({ line }) => print(line),
    leaving: () => {},
    up: () => {},
    abandon: () => {},
  };
}

/** How the terminal shows colour, or "none" where it can't or the owner said NO_COLOR. */
export function colorMode(environment: NodeJS.ProcessEnv): ColorMode {
  if (environment.NO_COLOR) return "none";
  return /truecolor|24bit/iu.test(environment.COLORTERM ?? "") ? "truecolor" : "256";
}

/** Whether the scene plays: a real terminal, big enough, that isn't CI or dumb. */
export function scenePlays(
  out: { readonly isTTY?: boolean; readonly columns?: number; readonly rows?: number },
  environment: NodeJS.ProcessEnv,
): boolean {
  return (
    out.isTTY === true &&
    (out.columns ?? 0) >= SCENE_WIDTH + 2 &&
    (out.rows ?? 0) >= SCENE_ROWS + 6 &&
    environment.TERM !== "dumb" &&
    !environment.CI
  );
}

/**
 * How `auni` tells its start here: the scene in a terminal with room, when it opens the web app
 * (the last stone), else plain lines.
 */
export function startTelling({ web }: { readonly web: boolean }): Telling {
  if (web && scenePlays(process.stdout, process.env)) return sceneTelling(colorMode(process.env));
  console.log("Starting Auni.");
  return plainTelling((line) => console.log(line));
}

/** Where the process's own output goes while the scene owns the terminal (takeOutput). */
export interface OutputRoute {
  /** From now on into `file`, what was held first; the terminal, if it can't be opened. */
  toLog(file: string): void;
  /** Back to the terminal, what was held first. */
  toTerminal(): void;
}

type Writes = Pick<NodeJS.WriteStream, "write">;

/**
 * Takes over `out` and `err`: what is written to them is held until it is sent to a log file or
 * back to the terminal. Writes to a log go straight to its file, so none is lost as Auni exits.
 * Nor is anything held: should the process end first (`ends` is the process: its exit, or an
 * error about to end it, which Node prints straight to the terminal), it goes to the terminal
 * then. `beforeTerminal` runs each time, before the terminal is written to again.
 */
export function takeOutput(
  out: Writes,
  err: Writes,
  {
    ends,
    beforeTerminal = () => {},
  }: {
    readonly ends?: Pick<NodeJS.EventEmitter, "on">;
    readonly beforeTerminal?: () => void;
  } = {},
): OutputRoute {
  const own = { out: out.write.bind(out), err: err.write.bind(err) };
  let held: { readonly to: "out" | "err"; readonly chunk: string | Uint8Array }[] | null = [];
  let log: number | null = null;
  const append = (fd: number, chunk: string | Uint8Array) =>
    typeof chunk === "string" ? writeSync(fd, chunk) : writeSync(fd, chunk);
  const route =
    (to: "out" | "err") =>
    (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      if (held) held.push({ to, chunk });
      else if (log !== null) append(log, chunk);
      const done = rest.find((arg) => typeof arg === "function") as (() => void) | undefined;
      done?.();
      return true;
    };
  out.write = route("out") as Writes["write"];
  err.write = route("err") as Writes["write"];
  const toTerminal = () => {
    beforeTerminal();
    out.write = own.out as Writes["write"];
    err.write = own.err as Writes["write"];
    for (const { to, chunk } of held ?? []) own[to](chunk);
    held = null;
    if (log !== null) closeSync(log);
    log = null;
  };
  const ending = () => {
    if (held) toTerminal();
  };
  ends?.on("exit", ending);
  ends?.on("uncaughtExceptionMonitor", ending);
  return {
    toLog(file) {
      if (!held) return;
      try {
        log = openSync(file, "a", 0o600);
      } catch {
        return toTerminal();
      }
      for (const { chunk } of held) append(log, chunk);
      held = null;
    },
    toTerminal,
  };
}

/** The longest Auni waits for the scene to clear itself off the terminal as it stops. */
const CLEAR_LIMIT_MS = 500;

function sceneTelling(color: ColorMode): Telling {
  const cleared = new Int32Array(new SharedArrayBuffer(4));
  const stage = new Worker(new URL("./stage-worker.ts", import.meta.url), {
    workerData: { color, columns: process.stdout.columns, cleared } satisfies StageStart,
  });
  // It never keeps Auni running, nor does its ending stop Auni.
  stage.unref();
  let playing = true;
  /** The ended scene is still the last thing on the terminal, so the stage can redraw it. */
  let still = false;

  const resized = () => tell({ kind: "columns", columns: process.stdout.columns });
  process.stdout.on("resize", resized);
  /** The scene is over, whole or cut short: the terminal is the owner's again. */
  const over = () => {
    playing = false;
    process.stdout.off("resize", resized);
    process.off("SIGINT", interrupted);
  };
  /**
   * A scene still playing is taken off the terminal, before anything else is written there; one
   * that ended stays, but is no longer the last thing there to redraw.
   */
  const clear = () => {
    if (still) void stage.terminate();
    still = false;
    if (!playing) return;
    tell({ kind: "clear" });
    Atomics.wait(cleared, 0, 0, CLEAR_LIMIT_MS);
    over();
    void stage.terminate();
    toTerminal("\u001B[?25h");
  };
  // Everything else printed meanwhile waits for the scene to end, or to be cleared away as Auni
  // stops, fails to start or exits, when the terminal gets it.
  const output = takeOutput(process.stdout, process.stderr, {
    ends: process,
    beforeTerminal: clear,
  });
  /** Gives the terminal back: the scene cleared, if it still plays, then what was held. */
  const abandon = () => output.toTerminal();
  // The scene has ended.
  stage.on("message", () => {
    over();
    still = true;
    // The terminal keeps the stones and what to know; Auni's working lines go to its log.
    output.toLog(auniLog());
  });
  // A scene that broke takes nothing with it: the terminal gets plain lines from here.
  stage.on("error", () => abandon());

  const tell = (event: ToStage) => {
    if (playing) stage.postMessage(event);
  };

  // Ctrl-C before Auni's own handler is listening (still opening its database) stops as it
  // always did; after, its handler stops Auni, and the scene gets out of the way of what it says.
  const interrupted = () => {
    abandon();
    if (process.listenerCount("SIGINT") === 0) process.kill(process.pid, "SIGINT");
  };
  process.once("SIGINT", interrupted);

  // Once the scene is over, played out or cut short, what's told is plain lines: on the
  // terminal, or in Auni's log once that has it.
  const plain = plainTelling((line) => console.log(line));
  let memory = false;
  return {
    say: (line) => (playing ? tell({ kind: "say", line }) : plain.say(line)),
    log: (line) => {
      if (!playing) plain.log(line);
    },
    waiting: (line) => {
      abandon();
      plain.waiting(line);
    },
    memoryReady: () => {
      if (!memory) tell({ kind: "memory" });
      memory = true;
    },
    firstRun: (ahead) => tell({ kind: "firstRun", ahead }),
    pageBuilding: () => (playing ? tell({ kind: "building" }) : plain.pageBuilding()),
    pageReady: () => tell({ kind: "page" }),
    brain: (found) => {
      if (playing) return tell({ kind: "brain", found });
      // A brain signed in once Auni is up fills its stone on the scene left on the terminal.
      if (still && found.name) stage.postMessage({ kind: "brain", found } satisfies ToStage);
      plain.brain(found);
    },
    leaving: () => tell({ kind: "leave" }),
    up: (opened) => tell({ kind: "up", opened }),
    abandon,
  };
}
