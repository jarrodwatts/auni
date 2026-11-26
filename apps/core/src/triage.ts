import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform, release } from "node:os";
import { join } from "node:path";

import { apps, brains } from "./apps/registry.ts";
import { auniLog, dataDir } from "./data-dir.ts";
import { doctor } from "./doctor.ts";
import { env } from "./env.ts";
import { heldSecrets, withoutSecrets } from "./feedback.ts";
import { appDir, installed, SOURCE, versionLine } from "./release/layout.ts";
import { serviceInstalled, serviceOutput } from "./service.ts";
import { fileSettingNames } from "./settings.ts";

// `auni triage`: the owner's own Claude Code or Codex, started in their terminal with a playbook
// (skills/auni/triage.md), finds out with them what is wrong with this Auni and drafts an issue
// in Auni's own report-a-problem form (.github/ISSUE_TEMPLATE/bug.yml, which feedback.ts fills
// for a card), as `t3 triage` does. It hands the agent one folder:
//
//   <data folder>/triage/<time>/
//     TRIAGE.md     where things are, then the playbook
//     context.md    this machine's facts: the version, where its source and output are, and
//                   what the agent may and may not read
//     doctor.json   `auni doctor --json`, as this command ran it
//     output.txt    Auni's latest output, with each secret Auni holds blanked
//
// No secret goes with it. The agent's environment is the owner's shell's, less every setting of
// Auni's (boot() reads them into this process, and an owner may export one too). Everything in the
// data folder but Auni's output, these folders and an install's source, and any .env a clone keeps
// beside its code, the agent's CLI is told it can't read, where it can hold itself to that
// (each brain's `terminal`). The playbook says the rest, and that it asks before changing anything.

export interface TriageFolder {
  readonly folder: string;
  /** TRIAGE.md, which the agent is told to read first. */
  readonly playbook: string;
  /** What the agent's CLI is told it can't read. */
  readonly hidden: readonly string[];
}

/** What in the data folder the agent may read: Auni's output, these folders, an install's source. */
const READABLE = ["auni.log", "postgres.log", "triage", "app"];

/** The .env files a folder keeps, where a clone keeps a developer's own keys. */
const envFilesIn = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.startsWith(".env") && name !== ".env.example")
        .map((name) => join(dir, name))
    : [];

/** Everything the agent's CLI is told it can't read (see the top of this file). */
function hiddenFromTheAgent(): string[] {
  const data = dataDir();
  const kept = existsSync(data)
    ? readdirSync(data)
        .filter((name) => !READABLE.includes(name))
        .map((name) => join(data, name))
    : [];
  // An install's cold copies of the database, taken by `auni update`.
  const backups = join(appDir(), "backups");
  return [
    ...kept,
    ...(existsSync(backups) ? [backups] : []),
    ...[SOURCE, join(SOURCE, "apps/core"), join(SOURCE, "apps/web")].flatMap(envFilesIn),
  ];
}

/** Core's own settings that hold a secret: a database's password, a key in a link, the token's. */
const CORE_SECRETS = ["DATABASE_URL", "TURN_TOKEN_SECRET", "ALCHEMY_API_KEY"];

/**
 * The owner's shell environment, less every setting of Auni's: the settings file's, every app's,
 * and core's secrets, with each RPC's address. A command the agent runs that needs one, such as
 * `auni doctor`, reads the settings file itself.
 */
export function agentEnv(shell: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const auni = new Set([
    ...fileSettingNames(),
    ...apps().flatMap(({ about }) =>
      Object.values(about.settings ?? {}).map(({ env: name }) => name),
    ),
    ...CORE_SECRETS,
  ]);
  return Object.fromEntries(
    Object.entries(shell).filter(([name]) => !auni.has(name) && !name.startsWith("RPC_URL_")),
  );
}

/** The last `lines` of a file, or null without one. */
function tail(file: string, lines: number): string | null {
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf8").split("\n").slice(-lines).join("\n");
}

/** Auni's latest output where it keeps it: the service's journal on Linux, and auni.log. */
function latestOutput(): string {
  const parts: string[] = [];
  if (platform() === "linux" && serviceInstalled()) {
    try {
      const journal = execFileSync(
        "journalctl",
        ["--user", "-u", "auni", "-n", "400", "--no-pager", "-o", "short-iso"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      parts.push(`# The service's journal (journalctl --user -u auni)\n\n${journal}`);
    } catch {
      // No journal to read for this user: auni.log may hold it.
    }
  }
  const log = tail(auniLog(), 400);
  if (log !== null) parts.push(`# ${auniLog()}\n\n${log}`);
  const output = parts.join("\n\n").trim();
  return output
    ? withoutSecrets(output, heldSecrets())
    : "Auni kept no output this command can find.";
}

/** Where Auni's output goes on, as the agent can follow it. */
function liveOutput(): string {
  const where = [
    serviceInstalled() ? `the service's: \`${serviceOutput()}\`` : null,
    `in a terminal once it has started, in the background, or a macOS service: \`${auniLog()}\``,
  ];
  return where.filter(Boolean).join("; ");
}

interface Facts {
  readonly at: Date;
  readonly folder: string;
  readonly version: string;
  readonly installed: boolean;
  readonly source: string;
  readonly data: string;
  readonly hidden: readonly string[];
  readonly output: string;
}

/** context.md: this machine's facts, as the playbook's steps read them. */
function triageContext(facts: Facts): string {
  return `# Auni triage context

Written by \`auni triage\` at ${facts.at.toISOString()}.

- Auni: ${facts.version}, ${facts.installed ? "an install (auni update updates it)" : "a clone of the source (git pull updates it)"}. This is the \`auni\` that ran triage; \`doctor.json\` says which Auni runs, if one does.
- This machine: ${platform()} ${arch()} (${release()}), Node ${process.version}

## Where things are

- This folder, for your notes, the issue's draft and any clone: ${facts.folder}
- The source of this version (read it, never edit it): ${facts.source}
- What \`auni doctor --json\` found as triage started: ${join(facts.folder, "doctor.json")}
- Auni's latest output, each secret Auni holds blanked: ${join(facts.folder, "output.txt")}
- Auni's output as it goes on, wherever Auni runs: ${facts.output}
- Auni's data folder: ${facts.data}. Read only Auni's output there (auni.log, postgres.log) and an install's source (app/versions/).

## Never read

These hold the owner's secrets, their keys or their money's records. Never open, print, copy or
search them, nor the OS keychain entry under "auni":

${facts.hidden.map((path) => `- ${path}`).join("\n") || "- (nothing here yet)"}
`;
}

const PLAYBOOK = join(SOURCE, "skills/auni/triage.md");

/** TRIAGE.md: where the facts are, then the playbook. */
function triageSeed(folder: string, playbook: string): string {
  return `An owner of Auni has a problem with it, and started this session with \`auni triage\`.

This machine's facts are in the context file, which says what you may and may not read:

    ${join(folder, "context.md")}

Follow the playbook below, starting by asking the owner what went wrong.

---

${playbook}`;
}

/** Writes the triage folder: the playbook, this machine's facts, doctor's findings, the output. */
export async function prepareTriage(): Promise<TriageFolder> {
  const at = new Date();
  const folder = join(dataDir(), "triage", at.toISOString().replace(/[:.]/gu, "-"));
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const write = (name: string, text: string) =>
    writeFileSync(join(folder, name), text, { mode: 0o600 });
  write("doctor.json", `${JSON.stringify(await doctor(), null, 2)}\n`);
  write("output.txt", `${latestOutput()}\n`);
  const hidden = hiddenFromTheAgent();
  write(
    "context.md",
    triageContext({
      at,
      folder,
      version: versionLine(),
      installed: installed(),
      source: SOURCE,
      data: dataDir(),
      hidden,
      output: liveOutput(),
    }),
  );
  write("TRIAGE.md", triageSeed(folder, readFileSync(PLAYBOOK, "utf8")));
  return { folder, playbook: join(folder, "TRIAGE.md"), hidden };
}

interface Agent {
  readonly id: string;
  readonly name: string;
  readonly command: readonly string[];
}

/** The owner's AI CLIs installed here that can triage, the one BRAIN names first. */
function triageAgents(triage: TriageFolder): Agent[] {
  const prompt = `Read the file "${triage.playbook}" and follow it exactly: it is your Auni triage playbook, and it starts by asking the owner what went wrong.`;
  return brains()
    .flatMap(({ about, brain }) => {
      const command = brain.terminal(prompt, triage.hidden);
      return command ? [{ id: about.id, name: about.name, command }] : [];
    })
    .toSorted((a, b) => Number(b.id === env.BRAIN) - Number(a.id === env.BRAIN));
}

/**
 * Starts the agent named (`--brain`), or the only one installed, or the one the owner picks, in
 * this terminal, in the triage folder, until they end it. With no terminal to start one in (a
 * coding agent ran this) or none installed, it says where the folder is instead. Its exit code.
 */
export async function startTriage(
  triage: TriageFolder,
  how: {
    /** The owner's shell environment, as it was before boot() read Auni's settings. */
    readonly shell: NodeJS.ProcessEnv;
    readonly named: string | null;
    /** The owner's answer in their terminal, or null with no terminal to start the agent in. */
    readonly pick: ((question: string) => Promise<string>) | null;
  },
): Promise<number> {
  const agents = triageAgents(triage);
  let agent = how.named === null ? agents[0] : agents.find(({ id }) => id === how.named);
  if (how.named !== null && !agent) {
    console.error(
      `No AI named "${how.named}" is installed here to triage with. Installed: ${agents.map(({ id }) => id).join(", ") || "none"}.`,
    );
    return 1;
  }
  if (!agent || !how.pick) {
    const why = agent
      ? "There is no terminal here to start it in"
      : `${brains()
          .map(({ about }) => about.name)
          .join(" and ")} aren't installed here`;
    console.log(
      `${why}. Everything triage needs is in\n  ${triage.folder}\nPoint any coding agent at ${triage.playbook} and ask it to follow it.`,
    );
    return 0;
  }
  if (how.named === null && agents.length > 1) {
    const menu = agents.map(({ name }, at) => `  [${at + 1}] ${name}`).join("\n");
    for (agent = undefined; !agent;) {
      const answer = (await how.pick(`Triage with:\n${menu}\n> `)).trim();
      agent = agents[Number(answer) - 1] ?? agents.find(({ id }) => id === answer);
    }
  }
  console.log(
    `Starting ${agent.name}. It asks what went wrong, and asks before it changes or posts anything.\n`,
  );
  const [command, ...args] = agent.command;
  const child = spawn(command!, args, {
    cwd: triage.folder,
    stdio: "inherit",
    env: agentEnv(how.shell),
  });
  const [code] = (await once(child, "exit")) as [number | null];
  return code ?? 1;
}
