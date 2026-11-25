import { existsSync } from "node:fs";
import { platform } from "node:os";
import { delimiter, join } from "node:path";

import type { PrivateFieldWire, SpareKeyWire } from "@auni/shared";
import { sql } from "drizzle-orm";

import {
  brainRows,
  brainsBlocked,
  fixLine,
  fromTheApp,
  ON_WINDOWS,
  type BrainRow,
} from "./agent/brain.ts";
import { lastPaired, PAIRING_TTL_MS, theOwner } from "./auth/owner.ts";
import { db } from "./db/client.ts";
import { actions, arrivals, fills } from "./db/schema.ts";
import { env } from "./env.ts";
import type { KeptKeys, WalletAddresses } from "./apps/contract.ts";
import { walletApp } from "./apps/registry.ts";
import type { BrowserTry } from "./open-browser.ts";
import { fieldWire } from "./private-fields.ts";
import { installed, runningVersion } from "./release/layout.ts";
import { runningAuni } from "./running.ts";
import { webAppBuilt } from "./web-app.ts";

// What is true of this machine's Auni, read fresh on every ask: the one source for `auni setup`,
// `auni doctor` and first run's `GET /setup` (routes/setup.ts). Each reader answers
// one thing and makes nothing: no keys, no wallet, no pairing code.
//
// `auni setup --json` walks a coding agent through what only the terminal can do, one answer at
// a time until it says stop, and hands over at the browser, where first run does the rest:
//
//   tools -> install -> brain -> start -> done
//
// Each answer's `say` is written to the owner ("you"), so the agent passes it on as it is, and a
// person who runs `auni setup` themselves reads the same words. What only the agent must do or
// never do is the skill's to say (skills/auni/SKILL.md), never `say`'s.
//
// No secret ever passes through the agent: a login is the owner's own command, the pairing link
// goes straight to the browser as Auni starts (start.ts), and keys go only into a private field.

/** "windows" where Auni can't run itself, only inside WSL. */
function platformFact(): "ok" | "windows" {
  return platform() === "win32" ? "windows" : "ok";
}

interface InstallFact {
  readonly version: string;
  /** Run from a clone (`pnpm auni`) rather than an install. */
  readonly checkout: boolean;
  /** The `auni` command is on the PATH; for a checkout, `pnpm auni` always is. */
  readonly onPath: boolean;
}

/** This version, and how its `auni` command is reached. */
function installFact(): InstallFact {
  const checkout = !installed();
  const onPath =
    checkout ||
    (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, "auni")));
  return { version: runningVersion(), checkout, onPath };
}

interface BrainsFact {
  readonly rows: readonly BrainRow[];
  /** Why no brain can think here whatever the owner logs in to, or null. */
  readonly blocked: string | null;
}

/** Every brain app and where it stands; on Windows, none is tried. */
export async function brainsFact(
  options: { readonly notReadyFreshMs?: number } = {},
): Promise<BrainsFact> {
  const blocked = brainsBlocked();
  if (blocked === ON_WINDOWS) return { rows: [], blocked };
  return { rows: await brainRows(options), blocked };
}

/** Core's /health, asked through the web app at WEB_ORIGIN: why it doesn't answer, or what it said. */
async function askWeb(): Promise<
  | { readonly unreachable: string }
  | {
      readonly unreachable: null;
      readonly browser: BrowserTry | null;
      /** Which Auni answered (versionLine), or null from one that didn't say. */
      readonly version: string | null;
    }
> {
  const answer = await fetch(`${env.WEB_ORIGIN}/core/health`, {
    signal: AbortSignal.timeout(5_000),
  }).catch((error: unknown) => error);
  if (!(answer instanceof Response))
    return {
      unreachable: (answer instanceof Error ? answer.message : String(answer)).split("\n")[0]!,
    };
  if (!answer.ok) return { unreachable: `it answered ${answer.status}` };
  const said = (await answer.json().catch(() => ({}))) as {
    browser?: BrowserTry | null;
    version?: string;
  };
  return { unreachable: null, browser: said.browser ?? null, version: said.version ?? null };
}

/** Why the web app doesn't reach core at WEB_ORIGIN, or null when it does. */
export async function webUnreachable(): Promise<string | null> {
  return (await askWeb()).unreachable;
}

/** Which Auni answers at WEB_ORIGIN, as it says it ("0.1.0 (5d9832f24)"), or null when none does. */
export async function answeringVersion(): Promise<string | null> {
  const web = await askWeb();
  return web.unreachable === null ? web.version : null;
}

interface RunningFact {
  /** An Auni holds this database's job runner. */
  readonly running: boolean;
  /** The web app answers at WEB_ORIGIN and reaches core. */
  readonly webAnswers: boolean;
  /**
   * How that Auni brought the owner's browser to it as it started (BrowserTry), with a pairing
   * link it opened more than 15 minutes ago read as `ran-out`; null until it has tried.
   */
  readonly browser: BrowserTry["how"] | "ran-out" | null;
}

async function runningFact(): Promise<RunningFact> {
  const [holder, web] = await Promise.all([runningAuni(), askWeb()]);
  const running = holder !== null;
  if (web.unreachable !== null) return { running, webAnswers: false, browser: null };
  const { browser } = web;
  const ranOut = browser?.how === "opened" && Date.now() - Date.parse(browser.at) > PAIRING_TTL_MS;
  return { running, webAnswers: true, browser: ranOut ? "ran-out" : (browser?.how ?? null) };
}

interface OwnerState {
  /** When the newest browser still signed in paired, or null with none. */
  readonly pairedAt: Date | null;
  /** When they said they saved their spare key somewhere safe. */
  readonly backupSavedAt: Date | null;
  /** When they said they'd save it later. */
  readonly backupLaterAt: Date | null;
  /** When they finished first run by sending their first take. */
  readonly welcomedAt: Date | null;
}

export async function ownerState(): Promise<OwnerState> {
  const [pairedAt, owner] = await Promise.all([lastPaired(), theOwner()]);
  return {
    pairedAt,
    backupSavedAt: owner.backupSavedAt,
    backupLaterAt: owner.backupLaterAt,
    welcomedAt: owner.welcomedAt,
  };
}

/**
 * Where the wallet's spare key stands, as first run offers it in a chat: not yet while the wallet
 * holds nothing worth keeping (see keyWorthSaving); then due, until they save it or say later.
 */
export function spareKey(
  state: Pick<OwnerState, "backupSavedAt" | "backupLaterAt">,
  worthSaving: boolean,
): SpareKeyWire {
  if (state.backupSavedAt) return "saved";
  if (state.backupLaterAt) return "later";
  return worthSaving ? "due" : "not-yet";
}

/**
 * Whether the wallet's key now guards money and the owner is free to save it: a trade has gone
 * through, or money came in and no card waits on them and no move is under way (the card it came
 * for declined, say, or its buy failed). An empty wallet's key is nothing to lose, and while money
 * that just landed waits on their Allow they are busy with what it's for.
 */
export async function keyWorthSaving(): Promise<boolean> {
  const [row] = await db.execute<{ worth: boolean }>(sql`
    select exists (select 1 from ${fills})
      or (
        exists (select 1 from ${arrivals} where ${arrivals.kind} = 'deposit')
        and not exists (
          select 1 from ${actions}
          where ${actions.status} in ('awaiting_permission', 'running')
        )
      ) as worth`);
  return row?.worth === true;
}

interface WalletFacts {
  /** The wallet app's id and name. */
  readonly app: string;
  readonly name: string;
  /** The private field that takes keys the owner already holds, when the app has one. */
  readonly bring: PrivateFieldWire | null;
  /** Null until the owner makes or brings a wallet. */
  readonly addresses: WalletAddresses | null;
}

export async function walletFacts(): Promise<WalletFacts> {
  const { about, provided } = walletApp();
  const addresses = await provided.addresses();
  return {
    app: about.id,
    name: about.name,
    bring: provided.bring ? fieldWire(provided.bring) : null,
    addresses: addresses.evm || addresses.solana ? addresses : null,
  };
}

/** Where this machine keeps the wallet's keys (never the keys); null when it keeps none. */
export async function keptKeys(): Promise<KeptKeys | null> {
  return (await walletApp().provided.keptHere?.where()) ?? null;
}

// `auni setup --json`, for a coding agent.

export const SETUP_STEPS = ["tools", "install", "brain", "start", "done"] as const;
type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * One step, as the agent acts on it:
 *   run   run `run.command` (in the background when it says so), then run setup again
 *   tell  pass `say` on to the owner, wait `waitSeconds`, then run setup again
 *   wait  wait `waitSeconds`, then run setup again
 *   stop  pass `say` on: setup is done, or blocked on something only the owner can change
 */
interface SetupAnswer {
  readonly step: SetupStep;
  readonly next: "run" | "tell" | "wait" | "stop";
  /** Plain words written to the owner, to pass on as they are. */
  readonly say: string;
  readonly run?: { readonly command: string; readonly background?: true };
  readonly waitSeconds?: number;
  /** The steps already true, in order. */
  readonly done: readonly SetupStep[];
}

/** What a coding agent's setup steps on. */
export interface SetupFacts {
  readonly platform: "ok" | "windows";
  readonly install: InstallFact;
  readonly brains: BrainsFact;
  readonly running: RunningFact;
  /** This version's web app is built (an install's always is), so starting it builds nothing. */
  readonly webBuilt: boolean;
  /** A browser is paired and signed in as the owner's. */
  readonly paired: boolean;
  /** Auni is reached through Tailscale (TAILSCALE_OWNER), where no browser pairs. */
  readonly tailscale: boolean;
}

/** Reads every fact a coding agent's setup steps on. Makes nothing. */
export async function readSetup(): Promise<SetupFacts> {
  const [brains, running, owner] = await Promise.all([brainsFact(), runningFact(), ownerState()]);
  return {
    platform: platformFact(),
    install: installFact(),
    brains,
    running,
    webBuilt: webAppBuilt(),
    paired: owner.pairedAt !== null,
    tailscale: env.TAILSCALE_OWNER !== undefined,
  };
}

/** The `auni` command as this machine reaches it. */
export function auniCommand({ checkout, onPath }: InstallFact = installFact()): string {
  return checkout ? "pnpm auni" : onPath ? "auni" : "~/.local/bin/auni";
}

/** The first step that isn't true yet, and what to do about it. */
export function nextStep(f: SetupFacts): SetupAnswer {
  const done: SetupStep[] = [];
  const at = (step: SetupStep, rest: Omit<SetupAnswer, "step" | "done">): SetupAnswer => ({
    step,
    ...rest,
    done: [...done],
  });

  if (f.platform === "windows") return at("tools", { next: "stop", say: ON_WINDOWS });
  done.push("tools");

  // Setup runs as `auni`, so an install (or a clone) is here; the PATH may not know it yet.
  done.push("install");
  const auni = auniCommand(f.install);
  const pathLine = f.install.onPath
    ? ""
    : " ~/.local/bin isn't on your PATH yet: add `export PATH=\"$HOME/.local/bin:$PATH\"` to your shell's profile.";

  if (f.brains.blocked)
    return at("brain", { next: "stop", say: `${f.brains.blocked} Then run setup again.` });
  const thinking = f.brains.rows.some(({ state }) => state === "ready" || state === "resting");
  // One the web app can make ready (its sign-in, or installing it) waits for first run, which
  // starts with it, on whichever device the owner opens Auni on.
  const inFirstRun =
    !thinking && f.brains.rows.some((row) => "fix" in row && fromTheApp(row.id, row.state));
  if (!thinking && !inFirstRun) {
    const fixes = f.brains.rows.flatMap((row) =>
      "fix" in row ? [`- ${fixLine(row, row.state, row.fix)}`] : [],
    );
    return at("brain", {
      next: "tell",
      say:
        "Auni thinks with an AI CLI you're logged in to on this computer, and none is ready " +
        `yet. Run one of these yourself, in your own terminal:\n${fixes.join("\n")}`,
      waitSeconds: 15,
    });
  }
  if (thinking) done.push("brain");

  if (!f.running.running)
    return at("start", {
      next: "run",
      say:
        "Auni isn't running yet. It starts its own database, its jobs and the web app" +
        (f.webBuilt ? "," : ", which builds the first time (about a minute),") +
        " and runs while the session that started it does; " +
        `\`${auni} service install\` keeps it running for good.${pathLine}`,
      run: { command: auni, background: true },
      waitSeconds: 15,
    });
  if (!f.running.webAnswers)
    return at("start", {
      next: "wait",
      say: `Auni is running; its web app is still starting at ${env.WEB_ORIGIN}${f.webBuilt ? "" : " (the first time, it builds for about a minute)"}.`,
      waitSeconds: 15,
    });
  if (!f.paired && !f.tailscale) {
    if (f.running.browser === null)
      return at("start", {
        next: "wait",
        say: `Auni's web app is up at ${env.WEB_ORIGIN}, and Auni is looking for a browser to open it in.`,
        waitSeconds: 5,
      });
    return at("start", { next: "tell", say: pairSay(f.running.browser, auni), waitSeconds: 15 });
  }
  done.push("start");

  const opened = f.tailscale
    ? `Auni is at ${env.WEB_ORIGIN}: open it on any of your devices signed in to your Tailscale account. It`
    : "Your browser is signed in to Auni, which";
  return at("done", {
    next: "stop",
    say:
      `${opened} asks what you believe, and takes it from there${inFirstRun ? ", signing in your AI with you" : ""}. ` +
      `\`${auni} doctor\` checks it any time.${pathLine}`,
  });
}

/** How to sign a browser in, by what the running Auni did as it started. */
function pairSay(browser: NonNullable<RunningFact["browser"]>, auni: string): string {
  const pair = `run \`${auni} pair\` in your own terminal and open the link it prints (it works once, for 15 minutes).`;
  if (browser === "opened")
    return `Auni opened in your browser, signed in as you: look for its tab. If you closed it, ${pair}`;
  if (browser === "ran-out")
    return `The link Auni opened in your browser as it started has run out: ${pair}`;
  if (browser === "not-opened") return `Auni couldn't open your browser. To sign in, ${pair}`;
  // No screen here: the browser is on another computer, which reaches this one's web app through ssh.
  const command = tunnelCommand();
  const tunnel = command
    ? ` If you reach this computer over ssh, connect with \`${command}\` first, then open the link in the browser on yours.`
    : "";
  return `Auni found no screen on this computer to open a browser on. To sign in, ${pair}${tunnel}`;
}

function tunnelCommand(): string | null {
  const { hostname, port } = new URL(env.WEB_ORIGIN);
  if (hostname !== "localhost" && hostname !== "127.0.0.1") return null;
  return `ssh -L ${port || 80}:127.0.0.1:${env.WEB_PORT} <this computer>`;
}

/** One answer as a person reads it, for `auni setup` without --json. */
export function said(facts: SetupFacts, answer = nextStep(facts)): string {
  if (answer.run)
    return [
      "Auni isn't running.",
      `Run ${answer.run.command}`,
      "Keep the terminal open while you use it.",
      ...(facts.webBuilt ? [] : ["The web app builds on the first start (about a minute)."]),
    ].join("\n");
  if (answer.step === "start" && answer.next === "wait")
    return facts.running.webAnswers
      ? "Auni is up. Opening your browser."
      : "Auni is starting the web app.";
  if (answer.step === "start" && answer.next === "tell") {
    const command = `${auniCommand(facts.install)} pair`;
    if (facts.running.browser === "opened")
      return `Open the Auni tab in your browser. If you closed it, run ${command} for a new sign-in link.`;
    const tunnel = facts.running.browser === "no-screen" ? tunnelCommand() : null;
    const pair = `Run ${command} on the computer running Auni, then open the link. It works once and expires after 15 minutes.`;
    return tunnel
      ? `If your browser is on another computer, forward the port from there first:\n  ${tunnel}\n\n${pair}`
      : pair;
  }
  if (answer.step === "done")
    return facts.tailscale
      ? `Open ${env.WEB_ORIGIN} on a device signed in to your Tailscale account.`
      : `Open ${env.WEB_ORIGIN} and tell Auni a take.`;
  return answer.say;
}
