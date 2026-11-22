import { EVM_CHAIN_KEYS, NETWORKS, type NetworkKey } from "@auni/shared";
import { and, count, gt, isNull, lt, sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { fixLine, whichBrainSays } from "./agent/brain.ts";
import { reachFindings } from "./always-on.ts";
import { appTroublesNow, troubleWords } from "./app-troubles.ts";
import { appById } from "./apps/registry.ts";
import { settingsFile } from "./data-dir.ts";
import { db, pingDatabase } from "./db/client.ts";
import { pendingMigrations } from "./db/migrations.ts";
import { jobs } from "./db/schema.ts";
import { env, rpcUrlVar } from "./env.ts";
import { keepsNoStateAt, publicClient, rpcFor, solanaRpc } from "./money/chains.ts";
import { heldMoves } from "./money/reconcile.ts";
import { transferLogs } from "./money/evm-history.ts";
import { checkRelease } from "./release/check.ts";
import { installed, runningVersion, versionDir, versionLine } from "./release/layout.ts";
import { byRelease } from "./release/tags.ts";
import type { RepairId } from "./repairs.ts";
import { runningAuni, where, type RunningAuni } from "./running.ts";
import { lingers, ownCommand, serviceCommand, serviceInstalled } from "./service.ts";
import { answeringVersion, brainsFact, keptKeys, walletFacts, webUnreachable } from "./setup.ts";

/**
 * `auni doctor`: whether each part Auni needs works on this machine, and what to do where one
 * doesn't. A fix is something to act on; a note is a limit worth knowing that needs nothing. A
 * finding something safe can mend names the repair that does (repairs.ts), which
 * `auni doctor --fix` runs when it is recommended.
 */

export interface Finding {
  readonly check:
    | "version"
    | "database"
    | "runner"
    | "service"
    | "rpc"
    | "brain"
    | "wallet"
    | "apps"
    | "web"
    | "always-on";
  readonly status: "ok" | "note" | "fix";
  readonly says: string;
  readonly repair?: { readonly id: RepairId; readonly recommended: boolean };
}

const by = (id: RepairId, recommended = true): Finding["repair"] => ({ id, recommended });

type Check = () => Promise<Finding[]>;

const said = (error: unknown) =>
  (error instanceof Error
    ? (error as { shortMessage?: string }).shortMessage || error.message
    : String(error)
  ).split("\n")[0]!;

/**
 * Runs each check, the database's first: the runner check needs it to connect, and the wallet and
 * apps checks need it at this version's schema too. One still at an older schema is most often a
 * running Auni's, older than its code, which the runner check says to restart.
 */
export async function doctor(): Promise<Finding[]> {
  const [version, database, unreachable] = await Promise.all([
    guarded("version", checkVersion),
    guarded("database", checkDatabase),
    guarded("database", async () => (await pingDatabase(), [])),
  ]);
  const connects = unreachable.length === 0;
  const current = connects && database.every(({ status }) => status === "ok");
  const first = (check: "runner" | "wallet" | "apps") =>
    [{ check, status: "fix", says: "needs the database first" }] as const;
  const rest = await Promise.all([
    connects ? guarded("runner", checkRunner) : first("runner"),
    guarded("service", checkService),
    guarded("rpc", checkRpcs),
    guarded("brain", checkBrain),
    current ? guarded("wallet", checkWallet) : first("wallet"),
    current ? guarded("apps", checkApps) : first("apps"),
    guarded("web", checkWeb),
    guarded("always-on", checkAlwaysOn),
  ]);
  return [...version, ...database, ...rest.flat()];
}

/** One line a finding, as `auni doctor` prints it. */
export function line({ check, status, says }: Finding): string {
  return `${status.padEnd(4)} ${check}: ${says}`;
}

/** How long one check may take: a busy RPC can ask to be waited on for minutes. */
const CHECK_MS = 45_000;

async function guarded(check: Finding["check"], run: Check): Promise<Finding[]> {
  try {
    return await Promise.race([
      run(),
      sleep(CHECK_MS, null, { ref: false }).then(() => {
        throw new Error(`no answer within ${CHECK_MS / 1_000} seconds`);
      }),
    ]);
  } catch (error) {
    return [{ check, status: "fix", says: said(error) }];
  }
}

/**
 * The version running, and whether a newer release is out (`auni update` takes it), as the
 * installer of the version running checks it: a release no key it lists signed isn't "out".
 */
const checkVersion: Check = async () => {
  const running = `v${runningVersion()}`;
  if (!installed())
    return [{ check: "version", status: "ok", says: `${running}, from a source checkout` }];
  const newest = await checkRelease({
    installer: join(versionDir(running), "install.sh"),
    env: process.env,
  }).catch((error: unknown) => error as Error);
  if (newest instanceof Error)
    return [
      {
        check: "version",
        status: "note",
        says: `${running} (couldn't check for a newer one: ${said(newest)})`,
      },
    ];
  return [
    byRelease(newest.version, running) > 0
      ? {
          check: "version",
          status: "note",
          says: `${running}; ${newest.version} is out: auni update`,
        }
      : { check: "version", status: "ok", says: `${running}, the newest` },
  ];
};

const checkDatabase: Check = async () => {
  try {
    await pingDatabase();
  } catch (error) {
    return [
      {
        check: "database",
        status: "fix",
        says: `can't connect (${said(error)}): check DATABASE_URL, or unset it for Auni's own Postgres`,
      },
    ];
  }
  const pending = await pendingMigrations(env.DATABASE_URL);
  return [
    pending === 0
      ? { check: "database", status: "ok", says: "connects, at this version's schema" }
      : {
          check: "database",
          status: "fix",
          says: `${pending} migrations to apply: \`auni\` applies them as it starts`,
        },
  ];
};

const checkRunner: Check = async () => {
  const holder = await runningAuni();
  if (!holder)
    return [
      serviceInstalled()
        ? {
            check: "runner",
            status: "fix",
            says: "Auni isn't running, though its service is installed",
            repair: by("start-service"),
          }
        : {
            check: "runner",
            status: "fix",
            says: "Auni isn't running: start it with `auni`, or keep it running with `auni service install`",
            // Not unasked on this computer, where how Auni runs is the owner's to choose; always
            // on, they chose it (`auni up --always-on` installs it).
            repair: by("install-service", Boolean(env.TAILSCALE_OWNER)),
          },
    ];
  // Code newer than the Auni running reads its jobs as that code would: the restart comes first.
  const behind = await behindItsCode(holder);
  if (behind) return [behind];
  const [[overdue], failed, held] = await Promise.all([
    db
      .select({ jobs: count() })
      .from(jobs)
      .where(
        and(
          isNull(jobs.finishedAt),
          isNull(jobs.startedAt),
          lt(jobs.runAt, sql`now() - interval '5 minutes'`),
        ),
      ),
    db
      .select({ kind: jobs.kind, jobs: count(), error: sql<string>`max(${jobs.error})` })
      .from(jobs)
      .where(
        and(sql`${jobs.outcome} = 'failed'`, gt(jobs.finishedAt, sql`now() - interval '1 day'`)),
      )
      .groupBy(jobs.kind),
    heldMoves(),
  ]);
  const findings: Finding[] = [];
  if (overdue && overdue.jobs > 0)
    findings.push({
      check: "runner",
      status: "fix",
      says: `${overdue.jobs} jobs are over 5 minutes late: Auni's output says what holds them up`,
    });
  if (held.length > 0)
    findings.push({
      check: "runner",
      status: "fix",
      says: `${held.length} moves are held, waiting on you (${held.join(", ")}): each card says why, with Check again and Close`,
    });
  for (const { kind, jobs: many, error } of failed)
    findings.push({
      check: "runner",
      status: "note",
      says: `${many} ${kind} jobs failed in the last day, the latest: ${error}`,
    });
  return findings.length > 0
    ? findings
    : [{ check: "runner", status: "ok", says: `running ${where(holder)}, nothing late` }];
};

/**
 * Whether the Auni running here runs older code than its folder now holds, as after a `git pull`
 * in a clone: it runs, the web app it built included, as it started until it starts again. Its
 * service is restarted unasked only when it runs from this very folder.
 */
async function behindItsCode(holder: RunningAuni): Promise<Finding | null> {
  const running = holder.here ? await answeringVersion() : null;
  const here = versionLine();
  if (running === null || running === here) return null;
  const restarts =
    holder.as === "service" && serviceCommand()?.join("\n") === ownCommand().join("\n");
  return restarts
    ? {
        check: "runner",
        status: "fix",
        says: `Auni's service runs ${running}, and its folder now holds ${here}`,
        repair: by("restart-service"),
      }
    : {
        check: "runner",
        status: "note",
        says: `Auni runs ${running} ${where(holder)}, and this folder holds ${here}: restart it to run this one`,
      };
}

/**
 * Whether the service installed here can run Auni, and keep it running: its command still on
 * disk, and on Linux its start at boot (linger). Nothing where none is installed: the runner's
 * finding says how Auni runs then.
 */
const checkService: Check = async () => {
  const command = serviceCommand();
  if (!command) return [];
  const gone = command.find((part) => part.startsWith("/") && !existsSync(part));
  const findings: Finding[] = [];
  if (gone)
    findings.push({
      check: "service",
      status: "fix",
      says: `it runs ${gone}, which is gone, so it can't start: \`auni service install\` writes it again`,
      repair: by("rewrite-service"),
    });
  if (lingers() === false)
    findings.push({
      check: "service",
      status: "fix",
      says: "Auni stops when you log out, and starts again only when you log in",
      repair: by("linger"),
    });
  return findings.length > 0
    ? findings
    : [{ check: "service", status: "ok", says: "installed, and starts by itself" }];
};

/** An address no token is sent to, so the log probe asks for a full range and gets little back. */
const NOBODY = "0x0000000000000000000000000000000000000001";
/** Blocks the probes reach back: as the sweep asks, and an hour or more on every network. */
const PROBE_BLOCKS = 1_000;

const checkRpcs: Check = async () =>
  (
    await Promise.all([
      ...EVM_CHAIN_KEYS.map((chain) => guarded("rpc", () => checkEvmRpc(chain))),
      guarded("rpc", checkSolanaRpc),
    ])
  ).flat();

/** "Monad, through its public RPCs (RPC_URL_MONAD sets your own)". */
function through(chain: NetworkKey): string {
  const { source } = rpcFor(chain);
  const by =
    source === "own"
      ? `through ${rpcUrlVar(chain)}`
      : source === "alchemy"
        ? `through Alchemy (${rpcUrlVar(chain)} sets your own)`
        : `through its public RPCs (${rpcUrlVar(chain)} sets your own)`;
  return `${NETWORKS[chain].name}, ${by}`;
}

async function checkEvmRpc(chain: (typeof EVM_CHAIN_KEYS)[number]): Promise<Finding[]> {
  const client = publicClient(chain);
  const fix = (what: string, error: unknown): Finding => ({
    check: "rpc",
    status: "fix",
    says: `${NETWORKS[chain].name} ${what} (${said(error)}): set ${rpcUrlVar(chain)} to an RPC that does`,
  });
  let head: number;
  try {
    head = Number(await client.getBlockNumber());
  } catch (error) {
    return [fix("doesn't answer", error)];
  }
  const from = head - PROBE_BLOCKS + 1;
  // The logs as the sweep reads them, each RPC at the span it serves (see transferLogs).
  const [logs, balance] = await Promise.allSettled([
    transferLogs(chain, NOBODY, "in", from, head),
    client.getBalance({ address: NOBODY, blockNumber: BigInt(from) }),
  ]);
  if (logs.status === "rejected")
    return [
      fix(
        `won't list ${PROBE_BLOCKS.toLocaleString("en-US")} blocks of logs, which finds deposits`,
        logs.reason,
      ),
    ];
  // One that keeps no past state passes the search by; any other failure holds the sweep back.
  if (balance.status === "rejected")
    return [
      keepsNoStateAt(balance.reason)
        ? {
            check: "rpc",
            status: "note",
            says: `${through(chain)}: keeps no past balances, so coin sent straight to the wallet shows only in readings (${said(balance.reason)})`,
          }
        : fix("won't read past balances, which the sweep for deposits needs", balance.reason),
    ];
  return [{ check: "rpc", status: "ok", says: through(chain) }];
}

const checkSolanaRpc: Check = async () => {
  try {
    await solanaRpc<number>("getSlot", [{ commitment: "confirmed" }]);
    return [{ check: "rpc", status: "ok", says: through("solana") }];
  } catch (error) {
    return [
      {
        check: "rpc",
        status: "fix",
        says: `Solana doesn't answer (${said(error)}): set ${rpcUrlVar("solana")} to an RPC that does`,
      },
    ];
  }
};

const checkBrain: Check = async () => {
  const { rows, blocked } = await brainsFact();
  if (blocked) return [{ check: "brain", status: "fix", says: blocked }];
  // With one brain ready, the rest are notes: something else to think with, should it rest.
  const thinking = rows.some(({ state }) => state === "ready" || state === "resting");
  const which = whichBrainSays(settingsFile());
  const order: Finding[] = which ? [{ check: "brain", status: "note", says: which }] : [];
  return [
    ...order,
    ...rows.map((row): Finding => {
      if (row.state === "ready")
        return { check: "brain", status: "ok", says: `${row.name}, on ${row.login}` };
      if (row.state === "resting")
        return {
          check: "brain",
          status: "note",
          says: `${row.name}, on ${row.login}, is at its usage limit until ${row.until.toLocaleString()}`,
        };
      return {
        check: "brain",
        status: thinking ? "note" : "fix",
        says: fixLine(row, row.state, row.fix),
      };
    }),
  ];
};

const checkWallet: Check = async () => {
  const { app, addresses } = await walletFacts();
  if (!addresses)
    return [
      {
        check: "wallet",
        status: "ok",
        says: `${app}, with no wallet yet: the owner makes or brings one in the app's setup`,
      },
    ];
  const held = [
    addresses.evm && `EVM ${addresses.evm}`,
    addresses.solana && `Solana ${addresses.solana}`,
  ]
    .filter(Boolean)
    .join(", ");
  const kept = await keptKeys();
  return [
    {
      check: "wallet",
      status: "ok",
      says: `${app}: ${held}${kept ? `, its keys ${kept.place}` : ""}`,
    },
  ];
};

/**
 * What keeps going wrong for each app while Auni runs (app-troubles.ts): a key out of credits, or
 * a piece of work that fails each time, as a service that retired what Auni asks would.
 */
const checkApps: Check = async () => {
  const troubles = await appTroublesNow();
  if (troubles.length === 0)
    return [{ check: "apps", status: "ok", says: "nothing has kept failing" }];
  return troubles.map((trouble): Finding => {
    const name = appById(trouble.app)?.about.name ?? trouble.app;
    const { short, says } = troubleWords(trouble, name, (at) => at.toLocaleString());
    return { check: "apps", status: "fix", says: `${name}, ${short.toLowerCase()}: ${says}` };
  });
};

const checkWeb: Check = async () => {
  const why = await webUnreachable();
  if (why === null)
    return [{ check: "web", status: "ok", says: `${env.WEB_ORIGIN} answers and reaches core` }];
  return [
    {
      check: "web",
      status: "fix",
      says: `nothing answers at ${env.WEB_ORIGIN}/core/health (${why}): is Auni running, and is WEB_ORIGIN where the browser opens it?`,
    },
  ];
};

/** Whether Tailscale brings the owner's devices here, and this machine keeps Auni running. */
const checkAlwaysOn: Check = async () =>
  (await reachFindings()).map((finding) => ({ check: "always-on", ...finding }));
