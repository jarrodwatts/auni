import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { auniLog, dataDir } from "./data-dir.ts";
import { selfCommand } from "./release/layout.ts";

// `auni service install|uninstall`: Auni as a service of this machine, started at login (and,
// on Linux with lingering, at boot) and again if it stops, from the recipes in hosts/. It runs
// Auni as this shell does (release/layout.ts): an install's launcher, so `auni update` applies
// to it, or a checkout's own entry. Reads no env.ts: a service needs no database to be written.

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/** What the service carries over from this shell: where its CLIs are, and where Auni and its brains keep things. */
const CARRIED = ["PATH", "AUNI_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];

interface Host {
  readonly recipe: string;
  readonly file: string;
  /** The command, as the recipe writes it, and read back from the file it wrote. */
  readonly command: (args: readonly string[]) => string;
  readonly commandIn: (file: string) => string[];
  /** One carried variable as the recipe writes it. */
  readonly variable: (name: string, value: string) => string;
  /** Registers it and starts it; and the reverse. */
  readonly install: readonly (readonly string[])[];
  readonly uninstall: readonly (readonly string[])[];
  /** Starts and stops it, registered: for `auni update` and `auni stop`. */
  readonly start: readonly string[];
  readonly stop: readonly string[];
  /** Where its output goes, as a command to read it. */
  readonly output: string;
  readonly after: string;
}

function host(): Host {
  if (platform() === "linux") {
    const file = join(homedir(), ".config/systemd/user/auni.service");
    return {
      recipe: "hosts/systemd/auni.service",
      file,
      command: (args) => args.map((arg) => `"${systemd(arg)}"`).join(" "),
      commandIn: (unit) =>
        words(/^ExecStart=(.*)$/mu.exec(unit)?.[1], /"((?:[^"\\]|\\.)*)"/gu).map(unsystemd),
      variable: (name, value) => `Environment="${name}=${systemd(value)}"`,
      install: [
        ["systemctl", "--user", "daemon-reload"],
        ["systemctl", "--user", "enable", "--now", "auni"],
      ],
      uninstall: [["systemctl", "--user", "disable", "--now", "auni"]],
      start: ["systemctl", "--user", "start", "auni"],
      stop: ["systemctl", "--user", "stop", "auni"],
      output: "journalctl --user -u auni -n 100 --no-pager",
      after: "Its output: `journalctl --user -u auni -f`.",
    };
  }
  if (platform() === "darwin") {
    const file = join(homedir(), "Library/LaunchAgents/io.auni.plist");
    const domain = `gui/${userInfo().uid}`;
    return {
      recipe: "hosts/launchd/io.auni.plist",
      file,
      command: (args) => args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n"),
      commandIn: (plist) =>
        words(
          /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(plist)?.[1],
          /<string>(.*?)<\/string>/gu,
        ).map(unxml),
      variable: (name, value) => `    <key>${name}</key>\n    <string>${xml(value)}</string>`,
      install: [["launchctl", "bootstrap", domain, file]],
      uninstall: [["launchctl", "bootout", `${domain}/io.auni`]],
      start: ["launchctl", "bootstrap", domain, file],
      stop: ["launchctl", "bootout", `${domain}/io.auni`],
      output: `tail -n 100 ${auniLog()}`,
      after: `Its output: \`tail -f ${auniLog()}\`.`,
    };
  }
  throw new Error(
    `Auni has no service recipe for ${platform()}: run \`auni\`, or see hosts/ for Docker.`,
  );
}

/** systemd reads % as a specifier, and a quote or backslash as quoting. */
const systemd = (value: string) => value.replace(/["\\]/gu, "\\$&").replaceAll("%", "%%");
const xml = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;");
const unsystemd = (value: string) => value.replace(/\\(.)/gu, "$1").replaceAll("%%", "%");
const unxml = (value: string) => value.replaceAll("&lt;", "<").replaceAll("&amp;", "&");
/** Each match of `each` in `text`: its first group. */
const words = (text: string | undefined, each: RegExp) =>
  [...(text ?? "").matchAll(each)].map(([, word]) => word!);

// What a command prints goes to stderr, so `auni up --always-on --json` prints only its report.
const run = (command: readonly string[]) =>
  execFileSync(command[0]!, command.slice(1), { stdio: ["inherit", 2, 2] });

/** Writes the service for this machine from its recipe and starts it; says where it is. */
export function installService(): string {
  const { recipe, file, command, variable, install, after } = host();
  // And that it runs as the service, so any command can say so, and stop it as one (running.ts).
  const carried = [
    variable("AUNI_RUNS_AS", "service"),
    ...CARRIED.flatMap((name) => {
      const value = process.env[name]?.trim();
      return value ? [variable(name, value)] : [];
    }),
  ];
  const filled = readFileSync(join(REPO, recipe), "utf8")
    .replace("@COMMAND@", command(ownCommand()))
    .replaceAll("@HOME@", dataDir())
    .replaceAll("@LOG@", auniLog())
    .replace("@ENVIRONMENT@\n", carried.map((line) => `${line}\n`).join(""));
  mkdirSync(join(file, ".."), { recursive: true });
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeFileSync(file, filled);
  install.forEach(run);
  // Said only where lingering isn't on: with it, the service runs with nobody logged in already.
  const linger =
    platform() === "linux" && lingers() !== true
      ? `\nTo keep it running while you're logged out: \`loginctl enable-linger ${userInfo().username}\`.`
      : "";
  return `Auni runs as a service now (${file}).\n${after}${linger}`;
}

/** Whether Auni runs as a service of this machine. */
export function serviceInstalled(): boolean {
  try {
    return existsSync(host().file);
  } catch {
    return false; // no recipe for this machine, so none was installed
  }
}

/** The command a service installed from here runs: Auni as this shell runs it (release/layout.ts). */
export const ownCommand = (): string[] => [...selfCommand(), "--no-open"];

/** The command the installed service runs, as its file says, or null with none installed. */
export function serviceCommand(): string[] | null {
  if (!serviceInstalled()) return null;
  const { file, commandIn } = host();
  return commandIn(readFileSync(file, "utf8"));
}

/** Where the service's output goes, as the command that shows its latest. */
export const serviceOutput = (): string => host().output;

/**
 * Whether this user's services run from boot with nobody logged in (systemd's "linger"), or null
 * where there is no such thing (macOS) or logind can't say. Without it, Linux stops a user's
 * services as their last session ends, and starts them only at their next login.
 */
export function lingers(): boolean | null {
  if (platform() !== "linux") return null;
  try {
    const said = execFileSync(
      "loginctl",
      ["show-user", userInfo().username, "--property=Linger", "--value"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return said === "yes" ? true : said === "no" ? false : null;
  } catch {
    return null;
  }
}

/** Lets this user's services run from boot, which most machines let a user do for themselves. */
export function enableLinger(): void {
  const user = userInfo().username;
  try {
    execFileSync("loginctl", ["enable-linger", "--no-ask-password", user], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch {
    throw new Error(
      `this machine wants an administrator for that: run \`sudo loginctl enable-linger ${user}\``,
    );
  }
}

/** Stops the installed service, which keeps it from restarting, until startService or the next login. */
export function stopService(): void {
  run(host().stop);
}

export function startService(): void {
  run(host().start);
}

/** Stops the service and removes it; Auni's data stays. */
export function uninstallService(): void {
  const { file, uninstall } = host();
  for (const command of uninstall) {
    try {
      execFileSync(command[0]!, command.slice(1), { stdio: "inherit" });
    } catch {
      // Not running, or never installed: removing the file is what's left.
    }
  }
  rmSync(file, { force: true });
  console.log(`Auni no longer runs as a service. Its data stays in ${dataDir()}.`);
}
