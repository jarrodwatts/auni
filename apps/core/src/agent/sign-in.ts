import type { BrainTaskWire, SignInView } from "@auni/shared";

import type { Brain, BrainCheck } from "../apps/contract.ts";
import { brains } from "../apps/registry.ts";
import { publishBrains } from "../conversation/stream.ts";
import type { PrivateField } from "../private-fields.ts";
import { checkAfresh, fromTheApp, type BrainRow } from "./brain.ts";

// Making the owner's AI ready from the web app, on any device, the way T3 Code does it: Auni
// installs a missing CLI into its own tools folder, or runs that CLI's own sign-in on this
// machine. What a sign-in shows (Codex's page and code, Claude Code's prompt) is on every open
// device at once (`GET /brains`, which `brains` on GET /live says to read again), and whatever
// device finishes it, every one sees the brain turn ready.
//
//   Sign in -> signing-in (a page and its code, or the CLI's prompt) -> checking -> gone, ready
//                \-> failed (in the CLI's words) -> Sign in again, or put away
//
// The one exception to "Auni never reads, stores, copies or forwards a CLI's login" (AGENTS.md):
// a line the owner types into a terminal view comes in through a private field (`signInField`)
// and goes to that CLI's prompt alone, never kept, logged, put in an error, or shown to the
// agent. The CLI keeps the login it gets in its own store, which Auni never reads.

/** A sign-in nobody finishes stops, as Codex's device code runs out after 15 minutes. */
const SIGN_IN_LIMIT_MS = 15 * 60_000;
/** An install that hangs (a registry that never answers) stops. */
const INSTALL_LIMIT_MS = 5 * 60_000;

interface Doing {
  task: BrainTaskWire;
  readonly stop: AbortController;
  /** The running sign-in's prompt, while it takes a typed line. */
  type?: (line: string) => void;
}

/** What Auni is doing for each brain, by id: one thing at a time, in memory, as core is one process. */
const doing = new Map<string, Doing>();

/** What Auni is doing to make this brain ready, or null. */
export function brainTask(id: string): BrainTaskWire | null {
  return doing.get(id)?.task ?? null;
}

function brainOf(id: string): Brain | null {
  return brains().find(({ about }) => about.id === id)?.brain ?? null;
}

/** The private field a sign-in's typed line goes in by. */
const fieldId = (id: string) => `${id}-sign-in`;

interface Task {
  readonly first: BrainTaskWire;
  readonly limitMs: number;
  /** What the owner reads when it ran past `limitMs`. */
  readonly ranOut: string;
  /** What the owner reads when the work finished but the brain's check doesn't see it; or null. */
  readonly didntTake: (check: BrainCheck) => string | null;
  readonly work: (signal: AbortSignal, now: Doing) => Promise<void>;
}

/**
 * Runs a task as the brain's one, saying each change to every tab, then checks the brain again:
 * one whose check sees what it did is gone from here, ready or on to its next step. One the owner
 * stopped is gone at once; any other end stays as `failed` until they act. False while another
 * runs for the brain.
 */
function begin(id: string, { first, limitMs, ranOut, didntTake, work }: Task): boolean {
  const busy = doing.get(id)?.task.kind;
  if (busy && busy !== "failed") return false;
  const stop = new AbortController();
  const now: Doing = { task: first, stop };
  doing.set(id, now);
  publishBrains();
  const timer = setTimeout(() => stop.abort(ranOut), limitMs);
  const current = () => doing.get(id) === now;
  const end = (task: BrainTaskWire | null) => {
    if (!current()) return;
    now.type = undefined;
    if (task) now.task = task;
    else doing.delete(id);
    publishBrains();
  };
  void work(stop.signal, now)
    .then(async () => {
      end({ kind: "checking" });
      const said = didntTake(await checkAfresh(id));
      end(said ? { kind: "failed", said } : null);
    })
    .catch((error: unknown) => {
      // The CLI's own words for why, which only the owner reads: never logged.
      const said = stop.signal.aborted
        ? String(stop.signal.reason)
        : error instanceof Error
          ? error.message
          : String(error);
      end({ kind: "failed", said });
    })
    .finally(() => clearTimeout(timer));
  return true;
}

/** Starts the brain's own sign-in; false when it has none, or Auni is busy with it already. */
export function startSignIn(id: string): boolean {
  const brain = brainOf(id);
  if (!brain?.signIn) return false;
  const signIn = brain.signIn.bind(brain);
  return begin(id, {
    first: { kind: "signing-in", view: null },
    limitMs: SIGN_IN_LIMIT_MS,
    ranOut:
      "Nobody finished signing in within 15 minutes, so it stopped. Sign in again when you're ready.",
    didntTake: (check) =>
      check.ready || check.why === "not-installed"
        ? null
        : "The sign-in finished, but it didn't take. Sign in again.",
    work: (signal, now) =>
      signIn({
        signal,
        show: (shown) => {
          const view: SignInView =
            shown.kind === "terminal" ? { ...shown, field: fieldId(id) } : shown;
          now.task = { kind: "signing-in", view };
          publishBrains();
        },
        onTyped: (write) => (now.type = write),
      }),
  });
}

/** Installs the brain's CLI into Auni's tools folder; false when it can't, or is busy already. */
export function startInstall(id: string): boolean {
  const brain = brainOf(id);
  if (!brain?.install) return false;
  const install = brain.install.bind(brain);
  return begin(id, {
    first: { kind: "installing" },
    limitMs: INSTALL_LIMIT_MS,
    ranOut: "The install didn't finish within 5 minutes, so it stopped. Try again.",
    didntTake: (check) =>
      !check.ready && check.why === "not-installed"
        ? "The install finished, but Auni still can't find it. Try again."
        : null,
    work: (signal) => install(signal),
  });
}

/** Stops what Auni is doing for the brain, or puts away a failure the owner has read. */
export function stopTask(id: string): void {
  const now = doing.get(id);
  if (!now) return;
  doing.delete(id);
  now.stop.abort();
  publishBrains();
}

/**
 * The private field each sign-in waiting on a typed line takes it by (routes/private.ts): what
 * the owner types goes to that CLI's prompt, and nowhere else.
 */
export function signInFields(): PrivateField[] {
  return [...doing].flatMap(([id, now]) => {
    if (!now.type) return [];
    const type = now.type;
    const name = brains().find(({ about }) => about.id === id)?.about.name ?? id;
    return [
      {
        id: fieldId(id),
        label: `${name} sign-in code`,
        goes: `It goes straight to ${name}'s own sign-in on this computer, and nowhere else.`,
        app: id,
        inputs: [{ name: "line", label: "Code", placeholder: "Paste the code here", set: false }],
        link: null,
        confirms: false,
        proof: false,
        check: () => Promise.resolve({ preview: "", notes: [] }),
        accept: ({ line }) => {
          type((line ?? "").trim());
          return Promise.resolve(null);
        },
      },
    ];
  });
}

/** What Auni can do from the web app for a brain as it stands: install its CLI, or sign it in. */
export function helpFor(row: BrainRow): { canInstall: boolean; canSignIn: boolean } {
  const app = "fix" in row ? fromTheApp(row.id, row.state) : null;
  return { canInstall: app === "install", canSignIn: app === "sign-in" };
}
