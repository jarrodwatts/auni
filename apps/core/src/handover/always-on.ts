import { spawn } from "node:child_process";

import { placeHere, upSaid, type UpReport } from "../always-on.ts";
import { dataDir } from "../data-dir.ts";
import { selfCommand } from "../release/layout.ts";
import { TakeOverRefused, type AlwaysOnAt } from "./take-over.ts";

// Always-on setup (always-on.ts) as a takeover uses it, in two halves:
//
//   before the laptop lets go   where Auni will be here (`placeHere`), found without changing
//                               anything: the laptop sends the owner to that address, port and
//                               all, and a machine that can't be always on is refused while the
//                               laptop still carries on
//   once all is in place        `auni up --always-on --port <that port> --json`, a process of
//                               its own (hosts/README.md): the service, lingering, `tailscale
//                               serve`, the settings. --json asks nothing, so a step only the
//                               owner can do (serving Auni's door takes root) comes back as the
//                               command to run, which the owner reads here as what's left

/** Where Auni will be always on here, or a TakeOverRefused saying why it can't be. */
export async function alwaysOnHere(): Promise<AlwaysOnAt> {
  const { place, steps } = await placeHere(null).catch((error: unknown) => {
    throw new TakeOverRefused(
      `Tailscale couldn't say what it serves on this machine (${error instanceof Error ? error.message.split("\n")[0] : String(error)}).`,
    );
  });
  if (!place) {
    const why = steps.at(-1)!.says.replace(/^Nothing changed: /u, "");
    throw new TakeOverRefused(`This machine can't keep Auni on yet: ${why}`);
  }
  return { address: place.address, port: place.port };
}

/**
 * Sets Auni up to stay on here, on `at`'s port, and says how it went: true once Auni is always
 * on at `at.address`, false with what's left said (the `sudo` line, say).
 */
export async function setUpAlwaysOn(
  shell: NodeJS.ProcessEnv,
  at: AlwaysOnAt,
  say: (text: string) => void = console.log,
): Promise<boolean> {
  say("Setting Auni up to stay on here (auni up --always-on).");
  const [command, ...args] = selfCommand();
  const child = spawn(
    command!,
    [...args, "up", "--always-on", "--port", String(at.port), "--json"],
    // What it does along the way goes to stderr, straight to the owner; its report to stdout.
    { env: { ...shell, AUNI_HOME: dataDir() }, stdio: ["ignore", "pipe", "inherit"] },
  );
  let printed = "";
  child.stdout.on("data", (chunk: Buffer) => (printed += String(chunk)));
  // "close", not "exit": a process can exit before what it wrote has all been read.
  await new Promise((resolve) => child.once("close", resolve));
  let report: UpReport;
  try {
    report = JSON.parse(printed) as UpReport;
  } catch {
    say("Always-on setup stopped before it said how it went: what it printed above says why.");
    return false;
  }
  say(upSaid(report));
  if (report.ok) return true;
  const runs = report.steps.flatMap(({ status, run }) => (status === "fix" && run ? [run] : []));
  if (runs.length > 0)
    say(
      `\nWhat's left is yours to run on this machine, then open ${at.address}:\n${runs.map((run) => `  ${run}`).join("\n")}`,
    );
  return false;
}
