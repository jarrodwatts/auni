import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { and, isNotNull, isNull } from "drizzle-orm";
import type { RequestHandler } from "express";

import { NoWallet } from "../apps/contract.ts";
import { walletApp } from "../apps/registry.ts";
import { dataDir, envFile } from "../data-dir.ts";
import { db } from "../db/client.ts";
import { exportDatabase } from "../db/export.ts";
import { jobs } from "../db/schema.ts";
import { env } from "../env.ts";
import { installed, runningVersion } from "../release/layout.ts";
import { carriedSettings, packed } from "./bundle.ts";
import { markHandedOver, handedOver } from "./marks.ts";
import { keysFor, newCode, proves, seal, type HandoverKeys } from "./seal.ts";
import type { Machine } from "./tailnet.ts";

// The laptop's half of handing Auni over to a machine that stays on (take-over.ts is the other's).
// The owner picks one of their machines in Settings and gets a command to run there. Until that
// machine asks, nothing changes here. Then:
//
//   waiting   a listener on this machine's tailnet address answers only the picked machine's
//             tailnet addresses, for 15 minutes, and only with the code's proof (seal.ts)
//      | the new machine sends the proof
//   handing   the job runner stops as `auni stop` stops it (turns end, a send in flight
//             finishes), the API takes no change, and everything Auni keeps is packed and sealed
//      | the sealed bundle goes, once: the code is spent
//   handed    still stopped, waiting up to two minutes for the new machine to say it opened it
//      | it says so, and where Auni will be (its always-on address, port and all): the
//      | commit, handed-over.json, is written (marks.ts)
//   taken     this Auni runs nothing from now on, and its page sends the owner to that address
//
// Anything else before the commit (the bundle cut off on the way, no word back, the new machine
// declining it) starts the job runner again: Auni carries on here as if nothing happened. The new
// machine puts the keys in place only after the commit, so two Aunis never sign with the same
// keys, and this machine's copy stays until the owner removes it.

/** What the running Auni lends a handover: its job runner (start.ts). */
export interface Laptop {
  /** Stops the job runner, as `auni stop` would: turns end, a send in flight gets two minutes. */
  stopJobs(): Promise<void>;
  /** Starts it again, when the handover didn't happen. */
  startJobs(): Promise<void>;
  /** Everything Auni keeps, packed for the new machine (packHere), read with the runner stopped. */
  pack(): Promise<Buffer>;
  /** Aborts as Auni stops, so a handover in flight ends quietly instead of querying or packing. */
  readonly signal?: AbortSignal;
}

/** How long the code works, from when the owner asks for it. */
const OFFER_MS = 15 * 60_000;
/** How long the laptop waits, stopped, for the new machine to say it opened the bundle. */
const ANSWER_MS = 2 * 60_000;
/** How long the listener stays after the commit, so an answer the new machine missed is heard again. */
const LINGER_MS = 5 * 60_000;
/** Wrong codes the listener takes before it closes for good. */
const MOST_WRONG = 5;

export type Stage = "waiting" | "handing" | "handed" | "taken" | "ended";
/** Why a handover ended without handing Auni over, as Settings says it. */
export type Ended =
  "expired" | "wrong_code" | "cancelled" | "cut_short" | "no_answer" | "declined" | "failed";

interface Offer {
  readonly machine: Machine;
  readonly keys: HandoverKeys;
  readonly expiresAt: Date;
  readonly answerMs: number;
  readonly server: Server;
  stage: Stage;
  ended?: Ended;
  wrong: number;
  /** Ends the offer once its 15 minutes are up, while it's still waiting. */
  readonly expiry: NodeJS.Timeout;
  /** Takes Auni back if the new machine hasn't said it opened the bundle in time. */
  answer?: NodeJS.Timeout;
  committing?: Promise<boolean>;
}

let laptop: Laptop | null = null;
let offer: Offer | null = null;

/** The running Auni's job runner, lent to a handover; null when it runs none (start.ts). */
export function lendToHandover(lent: Laptop | null): void {
  laptop = lent;
}

/** A handover can't start, for a reason the owner reads. */
export class HandoverRefused extends Error {}

/** The install line a fresh machine runs: install.sh from Auni's repository. */
const INSTALL = "curl -fsSL https://raw.githubusercontent.com/jarrodwatts/auni/main/install.sh";

/**
 * Opens a handover to `machine` from `here` (this machine, on the same tailnet), in place of any
 * one still waiting, and returns the one command the owner runs there.
 */
export async function offerHandover(
  machine: Machine,
  here: Machine,
  {
    forMs = OFFER_MS,
    answerMs = ANSWER_MS,
  }: { readonly forMs?: number; readonly answerMs?: number } = {},
): Promise<{ readonly command: string; readonly expiresAt: Date }> {
  if (!laptop)
    throw new HandoverRefused("Auni can be handed over only while it runs here with its jobs on.");
  if (offer && (offer.stage === "handing" || offer.stage === "handed"))
    throw new HandoverRefused(`Auni is being handed over to ${offer.machine.name} right now.`);
  if (carriedSettings(await settingsText()) === null)
    throw new HandoverRefused(
      "Your settings file (.env) has a value spread over several lines that names one of this machine's own settings, so it can't be carried cleanly. Put each setting on a line of its own.",
    );
  const address = here.ips.find((ip) => !ip.includes(":"));
  if (!address)
    throw new HandoverRefused("This machine has no tailnet address to hand Auni over on.");
  if (offer) end(offer, "cancelled");

  const code = newCode();
  const server = createServer();
  const opened: Offer = {
    machine,
    keys: await keysFor(code),
    expiresAt: new Date(Date.now() + forMs),
    answerMs,
    server,
    stage: "waiting",
    wrong: 0,
    expiry: setTimeout(() => {
      if (opened.stage === "waiting") end(opened, "expired");
    }, forMs).unref(),
  };
  const lent = laptop;
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    answer(opened, lent, req, res).catch((error: unknown) => {
      if (lent.signal?.aborted) return;
      console.error("a request to hand Auni over failed", error);
      if (!res.headersSent) reply(res, 500, "failed");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, address, () => resolve());
  }).catch(() => {
    clearTimeout(opened.expiry);
    throw new HandoverRefused(
      "Tailscale isn't up on this machine just now, so nothing can reach it.",
    );
  });
  offer = opened;

  const port = (server.address() as { port: number }).port;
  // The same version as this one, where this is an install, so the new machine can read its data.
  const version = installed() ? `AUNI_VERSION=v${runningVersion()} ` : "";
  return {
    command: `${INSTALL} | ${version}sh && AUNI_HANDOVER_CODE=${code} "$HOME/.local/bin/auni" take-over --from ${address}:${port}`,
    expiresAt: opened.expiresAt,
  };
}

/** How the handover stands, for Settings: never the code, which is shown once, when it's made. */
export function handoverState(): {
  readonly stage: Stage;
  readonly machine: string;
  readonly expiresAt: string;
  readonly ended?: Ended;
} | null {
  if (!offer) return null;
  return {
    stage: offer.stage,
    machine: offer.machine.name,
    expiresAt: offer.expiresAt.toISOString(),
    ...(offer.ended ? { ended: offer.ended } : {}),
  };
}

/** Calls off a handover still waiting for its machine; false once it's under way. */
export function cancelHandover(): boolean {
  if (offer?.stage === "handing" || offer?.stage === "handed") return false;
  if (offer?.stage === "waiting") end(offer, "cancelled");
  return true;
}

/**
 * Turns down what would change Auni while it's being handed over, and everything once it has
 * gone: then each request is told where Auni is now, which the web app sends the owner to.
 */
export const whileHandingOver: RequestHandler = (req, res, next) => {
  const handed = handedOver();
  if (handed) return void res.status(409).json({ error: "handed_over", ...handed });
  const handing = offer?.stage === "handing" || offer?.stage === "handed";
  if (handing && !["GET", "HEAD"].includes(req.method))
    return void res.status(409).json({ error: "handing_over", machine: offer!.machine.name });
  next();
};

function end(ended: Offer, why: Ended): void {
  ended.stage = "ended";
  ended.ended = why;
  clearTimeout(ended.expiry);
  clearTimeout(ended.answer);
  ended.server.close();
  ended.server.closeIdleConnections();
}

/** The handover didn't happen: Auni carries on here. */
async function takeBack(taken: Offer, lent: Laptop, why: Ended): Promise<void> {
  if (taken.stage !== "handing" && taken.stage !== "handed") return;
  end(taken, why);
  if (lent.signal?.aborted) return;
  await lent.startJobs();
}

const reply = (res: ServerResponse, status: number, error?: string) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(error ? { error } : { ok: true }));
};

/** The proof a request sent, and the address an `opened` says, from its small JSON body. */
async function bodyOf(req: IncomingMessage): Promise<{ proof?: unknown; address?: unknown }> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 1_024) return {};
  }
  try {
    return (JSON.parse(body) ?? {}) as { proof?: unknown; address?: unknown };
  } catch {
    return {};
  }
}

/**
 * The address the new machine says Auni will be at, where it's that machine's own tailnet name
 * over https, as always-on setup makes it (tailnetOrigin); null for anything else, so its page
 * can send the owner nowhere but there.
 */
function addressOn(machine: Machine, said: unknown): string | null {
  if (typeof said !== "string" || !URL.canParse(said)) return null;
  const url = new URL(said);
  return url.protocol === "https:" && url.hostname === machine.dnsName && url.origin === said
    ? said
    : null;
}

/** A request's own address, as the machine list keeps it (no IPv4-in-IPv6 prefix). */
const plain = (address: string | undefined) => address?.replace(/^::ffff:/u, "") ?? "";

async function answer(
  on: Offer,
  lent: Laptop,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Only the machine the owner picked: its tailnet addresses are the owner's own device.
  if (!on.machine.ips.includes(plain(req.socket.remoteAddress)))
    return reply(res, 403, "not_that_machine");
  if (req.method !== "POST") return reply(res, 404, "not_found");
  const { proof, address } = await bodyOf(req);
  if (typeof proof !== "string" || !proves(proof, on.keys)) {
    on.wrong += 1;
    if (on.wrong >= MOST_WRONG && on.stage === "waiting") end(on, "wrong_code");
    return reply(res, 403, "wrong_code");
  }
  if (req.url === "/handover/bundle") return handOver(on, lent, res);
  if (req.url === "/handover/opened") return opened(on, lent, res, address);
  if (req.url === "/handover/declined") {
    await takeBack(on, lent, "declined");
    return reply(res, 200);
  }
  reply(res, 404, "not_found");
}

async function handOver(on: Offer, lent: Laptop, res: ServerResponse): Promise<void> {
  if (on.stage !== "waiting")
    return reply(res, 410, on.stage === "ended" ? (on.ended ?? "ended") : "used");
  if (Date.now() > on.expiresAt.getTime()) {
    end(on, "expired");
    return reply(res, 410, "expired");
  }
  const cancelled = () => {
    end(on, "cancelled");
    if (!res.headersSent && !res.destroyed) reply(res, 410, "cancelled");
  };
  if (lent.signal?.aborted) return cancelled();
  on.stage = "handing";
  // Cut off before every byte went (the new machine gone, the network dropped): taken back.
  let gone = false;
  res.on("close", () => {
    if (res.writableFinished) return;
    gone = true;
    if (on.stage === "handed") void takeBack(on, lent, "cut_short");
  });
  let sealed: Buffer;
  try {
    await lent.stopJobs();
    if (lent.signal?.aborted) return cancelled();
    const busy = await jobsStillRunning();
    if (lent.signal?.aborted) return cancelled();
    if (busy) {
      // A send that outlasted the runner's two minutes: never hand over what's mid-send.
      on.stage = "waiting";
      await lent.startJobs();
      return reply(res, 409, "busy");
    }
    sealed = seal(on.keys, await lent.pack());
  } catch (error) {
    if (lent.signal?.aborted) return cancelled();
    console.error("Auni couldn't be packed to be handed over", error);
    await takeBack(on, lent, "failed");
    return reply(res, 500, "failed");
  }
  if (lent.signal?.aborted) return cancelled();
  if (gone) return takeBack(on, lent, "cut_short");
  on.stage = "handed";
  on.answer = setTimeout(() => void takeBack(on, lent, "no_answer"), on.answerMs).unref();
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": sealed.length,
  });
  res.end(sealed);
}

/**
 * The new machine opened the bundle, and says where Auni will be: the commit. Asked again, it
 * answers the same.
 */
async function opened(on: Offer, lent: Laptop, res: ServerResponse, said: unknown): Promise<void> {
  if (on.stage === "handed" && !on.committing) {
    const to = addressOn(on.machine, said);
    if (!to) return reply(res, 400, "bad_address");
    clearTimeout(on.answer);
    on.committing = markHandedOver({
      to,
      machine: on.machine.name,
      at: new Date().toISOString(),
    }).then(
      () => {
        on.stage = "taken";
        setTimeout(() => {
          on.server.close();
          on.server.closeIdleConnections();
        }, LINGER_MS).unref();
        return true;
      },
      async (error: unknown) => {
        // Unnoted, Auni stays here, and the new machine hears so.
        console.error("Auni couldn't note that it was handed over, so it carries on here", error);
        await takeBack(on, lent, "failed");
        return false;
      },
    );
  }
  if (on.committing && (await on.committing)) return reply(res, 200);
  reply(res, 409, "taken_back");
}

/** Whether a job is still marked running: one the runner's stop didn't wait out. */
async function jobsStillRunning(): Promise<boolean> {
  const [running] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(isNotNull(jobs.startedAt), isNull(jobs.finishedAt)))
    .limit(1);
  return running !== undefined;
}

async function settingsText(): Promise<string> {
  return readFile(envFile(), "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
}

/**
 * Everything this Auni keeps, packed: the database and routines as `auni export` writes them,
 * the wallet's keys where they're kept on this machine, and the owner's settings.
 */
export async function packHere(): Promise<Buffer> {
  const file = join(dataDir(), "exports", `handover-${Date.now()}.jsonl.gz`);
  let exported: Buffer;
  try {
    await exportDatabase(env.DATABASE_URL, file, runningVersion());
    exported = await readFile(file);
  } finally {
    await rm(file, { force: true });
  }
  const { about, provided } = walletApp();
  const keys = provided.keptHere
    ? await provided.revealKeys().catch((error: unknown) => {
        if (error instanceof NoWallet) return null;
        throw error;
      })
    : null;
  return packed({
    version: runningVersion(),
    wallet: keys ? { app: about.id, keys } : null,
    settings: carriedSettings(await settingsText()) ?? "",
    export: exported,
  });
}
