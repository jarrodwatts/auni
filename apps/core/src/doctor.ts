import { EVM_CHAIN_KEYS, NETWORKS, type NetworkKey } from "@auni/shared";
import { and, count, gt, isNull, lt, sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { fixLine, terminalBrainLine, whichBrainSays } from "./agent/brain.ts";
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
import {
  answeringVersion,
  auniCommand,
  brainsFact,
  keptKeys,
  walletFacts,
  webUnreachable,
} from "./setup.ts";

/**
 * `auni doctor`: whether each part Auni needs works on this machine, and what to do where one
 * doesn't. A fix is something to act on; a note is a limit worth knowing that needs nothing. A
 * finding something safe can mend names the repair that does (repairs.ts), which
 * `auni doctor --fix` runs when it is recommended.
 */

// Presentation facts stay out of the JSON and web diagnostics contracts.
const terminalDetail = Symbol("terminal detail");

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
  readonly [terminalDetail]?:
    | { readonly problem: string; readonly setting?: string }
    | { readonly ai: string; readonly needsAttention: boolean }
    | { readonly failedJobs: number }
    | "migrates-on-start"
    | "restart-to-update";
  readonly repair?: { readonly id: RepairId; readonly recommended: boolean };
  /** The chat holding the card this is about, where the owner acts on it. */
  readonly thread?: string;
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
export function line({ check, status, says, [terminalDetail]: detail }: Finding): string {
  const setting = typeof detail === "object" && "setting" in detail ? detail.setting : undefined;
  return (
    `${status.padEnd(4)} ${check}: ${says}` +
    (setting ? `\n     In ${settingsFile()}, set ${setting}=<url>` : "")
  );
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

function databaseReason(error: unknown): string | undefined {
  switch ((error as { code?: unknown } | null)?.code) {
    case "ECONNREFUSED":
      return "Connection refused.";
    case "CONNECT_TIMEOUT":
    case "ETIMEDOUT":
      return "Connection timed out.";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "Couldn't find the database host.";
    case "28P01":
    case "28000":
      return "The database didn't accept the login.";
    case "3D000":
      return "The named database doesn't exist.";
  }
}

const checkDatabase: Check = async () => {
  try {
    await pingDatabase();
  } catch (error) {
    return [
      {
        check: "database",
        status: "fix",
        [terminalDetail]: {
          problem: [
            databaseReason(error),
            `Check the database address in ${settingsFile()}, or remove it to use Auni's own database.`,
          ]
            .filter(Boolean)
            .join(" "),
          setting: "DATABASE_URL",
        },
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
          [terminalDetail]: "migrates-on-start",
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
  const heldIn = held.find(({ threadId }) => threadId !== null)?.threadId;
  if (held.length > 0)
    findings.push({
      check: "runner",
      status: "fix",
      [terminalDetail]: {
        problem:
          held.length === 1
            ? "1 move needs checking. Open its card in Auni to check its status."
            : `${held.length} moves need checking. Open their cards in Auni to check their status.`,
      },
      says:
        held.length === 1
          ? "1 move needs checking. Open its card in chat for details"
          : `${held.length} moves need checking. Open their cards in chat for details`,
      ...(heldIn ? { thread: heldIn } : {}),
    });
  for (const { kind, jobs: many, error } of failed)
    findings.push({
      check: "runner",
      status: "note",
      says: `${many} ${kind} jobs failed in the last day, the latest: ${error}`,
      [terminalDetail]: { failedJobs: many },
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
        [terminalDetail]: "restart-to-update",
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
      [terminalDetail]: {
        problem:
          "Auni stops when you log out. Let its background service keep running after logout.",
      },
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
      ...EVM_CHAIN_KEYS.map((chain) => checkNetwork(chain, () => checkEvmRpc(chain))),
      checkNetwork("solana", checkSolanaRpc),
    ])
  ).flat();

async function checkNetwork(network: NetworkKey, run: Check): Promise<Finding[]> {
  return (await guarded("rpc", run)).map((finding) => {
    if (finding.status !== "fix") return finding;
    const detail = finding[terminalDetail];
    return {
      ...finding,
      [terminalDetail]: {
        problem:
          typeof detail === "object" && "problem" in detail
            ? detail.problem
            : `${NETWORKS[network].name} isn't answering.`,
        setting: rpcUrlVar(network),
      },
    };
  });
}

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
  const fix = (what: string, problem: string, error: unknown): Finding => ({
    check: "rpc",
    status: "fix",
    [terminalDetail]: { problem: `${NETWORKS[chain].name} ${problem}.` },
    says: `${NETWORKS[chain].name} ${what} (${said(error)}): set ${rpcUrlVar(chain)} to an RPC that does`,
  });
  let head: number;
  try {
    head = Number(await client.getBlockNumber());
  } catch (error) {
    return [fix("doesn't answer", "isn't answering", error)];
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
        "didn't answer the deposit history check",
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
        : fix(
            "won't read past balances, which the sweep for deposits needs",
            "didn't answer the past balance check",
            balance.reason,
          ),
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
        [terminalDetail]: { problem: "Solana isn't answering." },
        says: `Solana doesn't answer (${said(error)}): set ${rpcUrlVar("solana")} to an RPC that does`,
      },
    ];
  }
};

const checkBrain: Check = async () => {
  const { rows, blocked } = await brainsFact();
  const picked =
    rows.find(({ state }) => state === "ready") ??
    rows.find(({ state }) => state === "resting") ??
    rows[0];
  const detail = {
    ai: terminalBrainLine(picked, blocked, auniCommand()),
    needsAttention: Boolean(blocked || picked?.state !== "ready"),
  };
  if (blocked) return [{ check: "brain", status: "fix", says: blocked, [terminalDetail]: detail }];
  // With one brain ready, the rest are notes: something else to think with, should it rest.
  const thinking = rows.some(({ state }) => state === "ready" || state === "resting");
  const which = whichBrainSays(settingsFile());
  const order: Finding[] = which ? [{ check: "brain", status: "note", says: which }] : [];
  const findings = [
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
  if (findings[0]) findings[0] = { ...findings[0], [terminalDetail]: detail };
  return findings;
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
      [terminalDetail]: {
        problem: `The web app isn't answering. Check auni.log and the web address in ${settingsFile()}.`,
      },
      says: `nothing answers at ${env.WEB_ORIGIN}/core/health (${why}): is Auni running, and is WEB_ORIGIN where the browser opens it?`,
    },
  ];
};

/** Whether Tailscale brings the owner's devices here, and this machine keeps Auni running. */
const checkAlwaysOn: Check = async () =>
  (await reachFindings()).map((finding) => ({ check: "always-on", ...finding }));

const LABELS: Record<Finding["check"], string> = {
  version: "Version",
  database: "Database",
  runner: "Background work",
  service: "Background service",
  rpc: "Networks",
  brain: "Your AI",
  wallet: "Your wallet",
  apps: "Apps",
  web: "Web app",
  "always-on": "Remote access",
} satisfies Record<Finding["check"], string>;

/** Summarizes the same findings that --json and web diagnostics read. */
export function doctorSummary(
  findings: readonly Finding[],
  auni: string,
  { styled = false, prompting = false }: { styled?: boolean; prompting?: boolean } = {},
): string {
  const paint = (code: number, text: string) => (styled ? `\u001B[${code}m${text}\u001B[0m` : text);
  const problem = (text: string) => (styled ? `${paint(33, "!")} ${text}` : text);
  const fixes = findings.filter(({ status }) => status === "fix");
  const stopped = fixes.find(
    ({ check, repair }) =>
      check === "runner" && (repair?.id === "start-service" || repair?.id === "install-service"),
  );
  const database = fixes.find(({ check }) => check === "database");
  const databaseDown = database && database[terminalDetail] !== "migrates-on-start";
  const webReady = findings.some(({ check, status }) => check === "web" && status === "ok");
  const needsStart = stopped && !databaseDown && !webReady;
  const failedJobs = findings.reduce((total, row) => {
    const detail = row[terminalDetail];
    return typeof detail === "object" && "failedJobs" in detail ? total + detail.failedJobs : total;
  }, 0);
  const needsRestart = findings.some((row) => row[terminalDetail] === "restart-to-update");
  const followUp = fixes.length > 0 || failedJobs > 0 || needsRestart;
  const details = `${auni} doctor --verbose`;
  const repair = needsStart
    ? stopped.repair?.recommended
    : fixes.some(({ repair }) => repair?.recommended);
  const state = databaseDown
    ? "Auni can't reach its database."
    : needsStart
      ? "Auni isn't running."
      : stopped
        ? "Web app is running, but background work is stopped."
        : followUp
          ? webReady
            ? "Auni is running, with checks to review."
            : "Auni needs attention."
          : "Auni is running.";
  const lines = [paint(1, state)];
  if (needsStart && !repair) lines.push(`Run: ${auni}`);
  if (repair && !prompting) lines.push(`Run: ${auni} doctor --fix`);

  const issues = fixes.filter(
    ({ check }) =>
      check !== "brain" &&
      check !== "rpc" &&
      !(database && (check === "wallet" || check === "apps")) &&
      !(databaseDown && (check === "runner" || check === "web")) &&
      !(needsStart && (check === "runner" || check === "database" || check === "web")),
  );
  for (const issue of issues) {
    const detail = issue[terminalDetail];
    const text =
      typeof detail === "object" && "problem" in detail
        ? detail.problem
        : issue.check === "database"
          ? `Check the database connection in ${settingsFile()} and run doctor with --verbose for details.`
          : issue.says;
    lines.push(problem(`${LABELS[issue.check]}: ${text}`));
  }
  const ai = findings
    .map((row) => row[terminalDetail])
    .find((detail) => typeof detail === "object" && "ai" in detail);
  if (ai) lines.push(ai.needsAttention ? problem(ai.ai) : ai.ai);
  else if (fixes.some(({ check }) => check === "brain"))
    lines.push(problem(terminalBrainLine(undefined, null, auni)));
  if (needsStart)
    lines.push(
      database ? "Waiting for startup: Web app, Your wallet, Apps" : "Waiting for startup: Web app",
    );
  else if (database) lines.push("Waiting for the database: Your wallet, Apps");

  if (needsRestart)
    lines.push(
      problem("Update pending: stop Auni and start it from this folder to run this version"),
    );
  if (failedJobs) {
    const tasks = failedJobs === 1 ? "task" : "tasks";
    lines.push(
      problem(
        `Background work: ${failedJobs} ${tasks} failed in the last 24 hours. Check auni.log for details.`,
      ),
    );
  }
  const localOnly =
    !env.TAILSCALE_OWNER &&
    findings.some(({ check, status }) => check === "always-on" && status !== "fix");
  if (localOnly) lines.push("Access: Only on this computer");

  const networks = findings.filter(({ check }) => check === "rpc");
  if (networks.length) {
    const count = (status: Finding["status"]) =>
      networks.filter((row) => row.status === status).length;
    const ready = count("ok");
    const parts = [`${ready} ${ready === 1 ? "chain" : "chains"} ready`];
    if (count("note")) parts.push(`${count("note")} with limits`);
    lines.push(paint(2, `Networks: ${parts.join(", ")}`));
    for (const issue of networks.filter(({ status }) => status === "fix")) {
      const detail = issue[terminalDetail];
      lines.push(
        problem(
          typeof detail === "object" && "problem" in detail
            ? detail.problem
            : "Couldn't check the networks.",
        ),
      );
    }
    if (count("fix")) lines.push(`Set a working network URL in ${settingsFile()}.`);
  }

  const healthy = new Set(
    findings
      .filter(
        ({ check, status }) =>
          check !== "brain" &&
          check !== "rpc" &&
          !(localOnly && check === "always-on") &&
          status === "ok" &&
          !issues.some((issue) => issue.check === check),
      )
      .map(({ check }) => LABELS[check]),
  );
  if (healthy.size) lines.push(paint(2, `Passed: ${[...healthy].join(", ")}`));
  lines.push(`All checks: ${details}`);
  return lines.join("\n");
}
