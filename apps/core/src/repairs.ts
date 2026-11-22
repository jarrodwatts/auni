import { serveDoorAgain } from "./always-on.ts";
import { holdAgain, letGo } from "./boot.ts";
import { doctor, line, type Finding } from "./doctor.ts";
import { cameUp, runningAuni, stopAuni, where } from "./running.ts";
import { enableLinger, installService, serviceOutput, startService } from "./service.ts";

// `auni doctor`'s repairs, as `t3 doctor` offers them: doctor says what it found (doctor.ts), and
// a finding something safe can mend carries the repair that does. In a terminal `auni doctor`
// asks about each, `--fix` runs the recommended ones unasked (for a script or a coding agent),
// and `--dry-run` only says what they would be.
//
// A repair only puts back how Auni runs on this machine: its service, its start at boot, a
// restart. None touches the wallet or its keys, a setting, the database or a move; what would
// need one stays a line saying what to do. A repair that needs Auni stopped (`stopsAuni`) has
// its service stopped around it, running moves finishing first, and started again after, even
// when the repair fails. Always on, `tailscale serve` is put back too: it changes no setting
// (WEB_ORIGIN stays), so Auni runs on through it; a repair that changed one would run whileStopped.

interface Repair {
  /** What it does, as the owner is asked it. */
  readonly does: string;
  readonly stopsAuni: boolean;
  /** Does it; what it says along the way goes to `say`. */
  readonly run: (say: (text: string) => void) => Promise<void>;
}

/** How long a service started again has to take the job runner: Postgres and migrations first. */
const UP_MS = 90_000;

/**
 * Starts the service by `start` and waits for it to run Auni, or says where its output says why it
 * doesn't. Doctor lets go of the database meanwhile, so the service starts Postgres as its own
 * rather than wait for doctor to be done (boot.ts), and holds it again after, for what it says next.
 */
async function bringUp(start: () => void): Promise<void> {
  await letGo();
  try {
    start();
    if (!(await cameUp({ withinMs: UP_MS })))
      throw new Error(
        `Auni didn't come up within ${UP_MS / 1_000} seconds: \`${serviceOutput()}\` says why`,
      );
  } finally {
    await holdAgain();
  }
}

/** Each repair, in the order they run: the service written before it is started. */
const REPAIRS = {
  "rewrite-service": {
    does: "Write Auni's service again for this machine, and start it",
    stopsAuni: false,
    run: async (say) => bringUp(() => say(installService())),
  },
  linger: {
    does: "Start Auni's service at boot, and keep it running when you log out",
    stopsAuni: false,
    run: async () => enableLinger(),
  },
  "start-service": {
    does: "Start Auni's service",
    stopsAuni: false,
    run: async () => {
      // Started already, by the service written again before it.
      if (await runningAuni()) return;
      await bringUp(startService);
    },
  },
  "install-service": {
    does: "Run Auni as a service of this machine: started now, at login, and again if it stops",
    stopsAuni: false,
    run: async (say) => bringUp(() => say(installService())),
  },
  "tailscale-serve": {
    does: "Have Tailscale send your Auni address to Auni's door again, as `auni up --always-on` set it",
    stopsAuni: false,
    run: async () => serveDoorAgain(),
  },
  "restart-service": {
    does: "Restart Auni's service, so it runs the code its folder holds now",
    stopsAuni: true,
    run: async () => {},
  },
} satisfies Record<string, Repair>;

export type RepairId = keyof typeof REPAIRS;

/** Human-readable description of a doctor repair id, for UI and JSON output. */
export function repairDescription(id: RepairId): string {
  return REPAIRS[id].does;
}

/** Whether `id` is a known doctor repair id. */
export function isRepairId(id: string): id is RepairId {
  return Object.hasOwn(REPAIRS, id);
}

/**
 * Runs one safe doctor repair from the web UI (Diagnostics -> Fix). Never runs repairs that would
 * kill the currently serving process mid-response without returning a clean command instead.
 */
export async function runUiRepair(id: RepairId): Promise<{
  readonly ok: boolean;
  readonly message: string;
  readonly sudoCommand: string | null;
}> {
  if (id === "restart-service") {
    return {
      ok: false,
      message:
        "Restart Auni from your terminal so this session doesn't cut off mid-request: `auni stop && auni service install`.",
      sudoCommand: null,
    };
  }
  const notes: string[] = [];
  try {
    if (id === "linger") {
      enableLinger();
      return {
        ok: true,
        message: "Enabled boot lingering for your user service.",
        sudoCommand: null,
      };
    }
    if (id === "tailscale-serve") {
      await serveDoorAgain();
      return {
        ok: true,
        message: "Restored the Tailscale Serve route to Auni's door.",
        sudoCommand: null,
      };
    }
    if (id === "install-service" || id === "rewrite-service") {
      // Installing and starting a service while this process holds the DB runner lock causes the
      // newly started service to exit as a duplicate; require an external stop-and-start handoff.
      const running = await runningAuni().catch(() => null);
      if (running && running.as !== "service") {
        return {
          ok: false,
          message:
            "Auni is currently running from a terminal or background process. Stop it and run `auni stop && auni service install` so the OS service takes over cleanly.",
          sudoCommand: null,
        };
      }
      notes.push(installService());
      return {
        ok: true,
        message: notes.join(" ").trim() || "Service installed.",
        sudoCommand: null,
      };
    }
    if (id === "start-service") {
      if (!(await runningAuni())) startService();
      return { ok: true, message: "Started Auni's background service.", sudoCommand: null };
    }
    return { ok: false, message: "Unsupported repair.", sudoCommand: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const sudoMatch = /run `(sudo [^`]+)`/u.exec(message);
    return { ok: false, message, sudoCommand: sudoMatch?.[1] ?? null };
  }
}

/** A repair as a finding offers it (doctor.ts), and as `auni doctor --json` says it. */
interface Offer {
  readonly id: RepairId;
  /** Whether `--fix` runs it, and a terminal's question starts at yes. */
  readonly recommended: boolean;
  readonly does: string;
}

/** Each repair the findings offer, once, in the order they run. */
function offered(findings: readonly Finding[]): Offer[] {
  const order = Object.keys(REPAIRS);
  const byId = new Map(
    findings.flatMap(({ repair }) =>
      repair ? [[repair.id, { ...repair, does: REPAIRS[repair.id].does }]] : [],
    ),
  );
  return [...byId.values()].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/** A finding as `--json` says it: with what its repair does. */
const described = (finding: Finding) =>
  finding.repair
    ? { ...finding, repair: { ...finding.repair, does: REPAIRS[finding.repair.id].does } }
    : finding;

/**
 * Runs `run` with Auni's service stopped, if Auni runs as it here, and starts the service again
 * after, whether or not `run` worked. A repair that changes what Auni reads as it starts (always
 * on's WEB_ORIGIN, say) runs through this.
 */
export async function whileStopped(run: Repair["run"], say: (text: string) => void): Promise<void> {
  const running = await runningAuni();
  const service = running?.as === "service" && running.here ? running : null;
  if (service) {
    say("  Stopping Auni's service, letting running moves finish first.");
    if (!(await stopAuni(service)))
      throw new Error("Auni is still stopping after two and a half minutes, so nothing changed");
  }
  try {
    await run(say);
  } finally {
    if (service) {
      say("  Starting Auni's service again.");
      await bringUp(startService);
    }
  }
  if (running && !service) say(`  Auni runs ${where(running)}: restart it there to use this.`);
}

/** Runs each repair in turn, saying how each went; one that fails leaves the next to run. */
async function repair(chosen: readonly Offer[], say: (text: string) => void): Promise<void> {
  for (const { id, does } of chosen) {
    const repair: Repair = REPAIRS[id];
    say(`${does}.`);
    try {
      await (repair.stopsAuni ? whileStopped(repair.run, say) : repair.run(say));
      say("  Done.");
    } catch (error) {
      say(`  That didn't work: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }
}

export interface DoctorRun {
  /** The findings as JSON on stdout, and everything else said on stderr. */
  readonly json: boolean;
  /** Runs the recommended repairs unasked. */
  readonly fix: boolean;
  /** Says what the repairs would be and runs none, even with `fix`. */
  readonly dryRun: boolean;
  /** Asks the owner about one repair in their terminal; null where there is none to ask in. */
  readonly ask: ((offer: Offer) => Promise<boolean>) | null;
}

/**
 * `auni doctor`: what it finds, the repairs it offers and, once they've run, how things stand
 * after. Resolves to the exit code: 1 while anything is still to fix.
 */
export async function doctorCommand(run: DoctorRun): Promise<number> {
  const say = (text: string) => (run.json ? console.error(text) : console.log(text));
  let findings = await doctor();
  if (!run.json) console.log(findings.map(line).join("\n"));
  const offers = offered(findings);
  if (offers.length > 0) {
    say(
      [
        "",
        "Repairs:",
        ...offers.map(({ does, recommended }) => `  ${does}${recommended ? " (recommended)" : ""}`),
      ].join("\n"),
    );
    if (run.dryRun) say("Dry run: nothing changed.");
    else if (!run.fix && !run.ask)
      say(
        "Run auni doctor --fix to run the recommended ones, or auni doctor in a terminal to choose.",
      );
    else {
      const chosen: Offer[] = [];
      for (const each of offers)
        if (run.fix ? each.recommended : await run.ask!(each)) chosen.push(each);
      if (chosen.length === 0)
        say(run.fix ? "None is recommended: nothing changed." : "Nothing changed.");
      else {
        say("");
        await repair(chosen, say);
        findings = await doctor();
        if (!run.json) console.log(["", "Now:", ...findings.map(line)].join("\n"));
      }
    }
  }
  if (run.json) console.log(JSON.stringify(findings.map(described), null, 2));
  return findings.some(({ status }) => status === "fix") ? 1 : 0;
}
