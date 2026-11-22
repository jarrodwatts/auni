import type { Me, TailscaleEnableResult, TailscaleStateWire } from "@auni/shared";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { hostname, platform, userInfo } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { doorSocket } from "./auth/tailscale.ts";
import type { Finding } from "./doctor.ts";
import { env } from "./env.ts";
import { enableLinger, lingers, serviceInstalled } from "./service.ts";
import { clearAlwaysOn, saveAlwaysOn, setBy } from "./settings.ts";

// Always-on Auni: this machine keeps Auni running, and the owner's devices reach it through
// Tailscale (auth/tailscale.ts says who comes in). `auni up --always-on` sets it up, in steps that
// each say what they did or what is left for the owner, and is safe to run again:
//
//   tailscale  this machine is on the owner's tailnet, not a tagged device, with HTTPS on
//   port       an https port Tailscale serves nothing else on: --port, or the one Auni's door
//              has already, or 443, or the next free one (8443, 8444...), said in the address
//   settings   TAILSCALE_OWNER (Self's login) and WEB_ORIGIN (this machine's tailnet address)
//   service    Auni as a service of this machine (service.ts), restarted on the new settings
//   linger     on Linux, the service starts at boot and runs with nobody logged in
//   serve      `tailscale serve` sends the port to Auni's door, a unix socket, which takes root
//   reaches    the address answers, through Tailscale, from Auni's door
//
// `staysOn` says whether the machine itself keeps Auni running, for doctor and Settings.

const run = promisify(execFile);

/** One step of `auni up --always-on`: done, a limit worth knowing, or what the owner must do. */
interface UpStep {
  readonly step: "tailscale" | "port" | "settings" | "service" | "linger" | "serve" | "reaches";
  readonly status: "done" | "note" | "fix";
  readonly says: string;
  /** The command that does what's left, for a fix only the owner can run (sudo, say). */
  readonly run?: string;
}

/** What `auni up --always-on --json` prints. */
export interface UpReport {
  /** Every step is done, or a note: Auni is always on, at `address`. */
  readonly ok: boolean;
  readonly address: string | null;
  /** The Tailscale login Auni answers, recorded as TAILSCALE_OWNER. */
  readonly owner: string | null;
  readonly machine: string;
  readonly steps: readonly UpStep[];
  readonly staysOn: StaysOn;
}

/** This machine as `tailscale status --json` says it. */
interface OnTailnet {
  /** The login of the Tailscale user this machine belongs to: the owner. */
  readonly login: string;
  /** Its name on the tailnet, with no closing dot: box.tailnet-example.ts.net. */
  readonly name: string;
}

/** This machine on its tailnet, or why it can't be Auni's always-on home yet. */
async function onTailnet(): Promise<OnTailnet | { readonly problem: string }> {
  let status: TailscaleStatus;
  try {
    status = JSON.parse((await run("tailscale", ["status", "--json"], { timeout: 15_000 })).stdout);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? {
          problem:
            "Tailscale isn't installed here: get it from tailscale.com/download, then sign in",
        }
      : { problem: "Tailscale doesn't answer here: is it running? `tailscale up` signs in" };
  }
  if (status.BackendState !== "Running" || !status.Self)
    return { problem: "Tailscale isn't connected here: `tailscale up` signs in" };
  const { Self } = status;
  if (Self.Tags?.length)
    return {
      problem:
        "this machine is a tagged device, which belongs to no one Tailscale can name: sign it in with your own account (`tailscale up --force-reauth`)",
    };
  const login = status.User?.[String(Self.UserID)]?.LoginName;
  const name = Self.DNSName?.replace(/\.$/u, "");
  if (!login || !name) return { problem: "Tailscale didn't say who this machine belongs to" };
  if (!status.CertDomains?.includes(name))
    return {
      problem:
        "your tailnet has HTTPS off, which Auni needs: turn on HTTPS certificates in the DNS page of Tailscale's admin console",
    };
  return { login, name };
}

interface TailscaleStatus {
  readonly BackendState?: string;
  readonly Self?: {
    readonly DNSName?: string;
    readonly UserID?: number;
    readonly Tags?: readonly string[] | null;
  };
  readonly User?: Readonly<Record<string, { readonly LoginName?: string }>>;
  readonly CertDomains?: readonly string[] | null;
}

/** The address the owner opens: https on the tailnet name, with the port unless it's 443. */
export function tailnetOrigin(name: string, port: number): string {
  return `https://${name}${port === 443 ? "" : `:${port}`}`;
}

/** What `tailscale serve` sends each port of `name` to (`unix:/path`, say); a port it holds otherwise is "something". */
async function served(name: string): Promise<ReadonlyMap<number, string>> {
  const { stdout } = await run("tailscale", ["serve", "status", "--json"], { timeout: 15_000 });
  const status = JSON.parse(stdout || "{}") as {
    readonly Web?: Record<string, { readonly Handlers?: Record<string, { Proxy?: string }> }>;
    readonly TCP?: Record<string, unknown>;
  };
  const routes = new Map<number, string>();
  for (const port of Object.keys(status.TCP ?? {})) routes.set(Number(port), "something");
  for (const [at, { Handlers = {} }] of Object.entries(status.Web ?? {})) {
    const colon = at.lastIndexOf(":");
    if (at.slice(0, colon) !== name) continue;
    const route = Handlers["/"]?.Proxy ?? Object.values(Handlers)[0]?.Proxy ?? "something";
    routes.set(Number(at.slice(colon + 1)), route);
  }
  return routes;
}

/** The https ports Auni takes when the owner names none, in turn: https's own, then the next ones. */
const PORTS = [443, ...Array.from({ length: 100 }, (_, at) => 8443 + at)];

/**
 * The port Auni is served on: `asked`, where it's free or the door's already; with none asked,
 * the one the door has (a run again keeps the address), else the first free one; null for none.
 */
export function portFor(routes: ReadonlyMap<number, string>, asked: number | null): number | null {
  const free = (port: number) => (routes.get(port) ?? doorRoute()) === doorRoute();
  if (asked !== null) return free(asked) ? asked : null;
  const door = [...routes].find(([, route]) => route === doorRoute());
  return door?.[0] ?? PORTS.find(free) ?? null;
}

/** Where `tailscale serve` should send the owner's requests: Auni's door. */
export const doorRoute = (): string => `unix:${doorSocket()}`;

/** The command that sends `port` to Auni's door; serving a socket takes root. */
const serveCommand = (port: number): readonly string[] => [
  "tailscale",
  "serve",
  "--bg",
  `--https=${port}`,
  doorRoute(),
];

/** Whether the machine keeps Auni running, and the sentence doctor and Settings say it in. */
interface StaysOn {
  readonly stays: boolean;
  /** It doesn't because it's a laptop, which is a limit to know rather than something to fix. */
  readonly laptop: boolean;
  readonly says: string;
  /** What the owner runs so it does, where something would. */
  readonly run?: string;
  /** The doctor repair that does it (repairs.ts), where one does. */
  readonly repair?: "install-service" | "linger";
}

/** Whether this machine keeps Auni running while the owner is away from it. */
export async function staysOn(): Promise<StaysOn> {
  if (await isLaptop())
    return {
      stays: false,
      laptop: true,
      says: "This is a laptop: Auni stops when the lid closes.",
    };
  if (!serviceInstalled())
    return {
      stays: false,
      laptop: false,
      says: "Auni runs only while the terminal that started it does.",
      run: "auni up --always-on",
      repair: "install-service",
    };
  if (platform() === "linux" && !(await serviceEnabled()))
    return {
      stays: false,
      laptop: false,
      says: "Auni's service is installed but doesn't start by itself.",
      run: "auni service install",
      repair: "install-service",
    };
  if (platform() === "darwin")
    return {
      stays: true,
      laptop: false,
      says: "Auni starts when you log in to this Mac, and runs while it's awake.",
    };
  if (lingers() !== true)
    return {
      stays: false,
      laptop: false,
      says: "Auni stops when you log out of this machine.",
      run: `sudo loginctl enable-linger ${userInfo().username}`,
      repair: "linger",
    };
  return {
    stays: true,
    laptop: false,
    says: "Auni starts when this machine does, and keeps running.",
  };
}

/** A laptop, by its chassis or a battery: it sleeps when its lid closes. */
async function isLaptop(): Promise<boolean> {
  if (platform() === "darwin")
    return run("pmset", ["-g", "batt"], { timeout: 5_000 }).then(
      ({ stdout }) => stdout.includes("InternalBattery"),
      () => false,
    );
  // SMBIOS chassis types: portable, laptop, notebook, sub notebook, convertible, detachable.
  const chassis = readOr("/sys/class/dmi/id/chassis_type")?.trim();
  if (chassis && ["8", "9", "10", "14", "31", "32"].includes(chassis)) return true;
  const supplies = existsSync("/sys/class/power_supply")
    ? readdirSync("/sys/class/power_supply")
    : [];
  return supplies.some(
    (supply) => readOr(`/sys/class/power_supply/${supply}/type`)?.trim() === "Battery",
  );
}

function readOr(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Whether systemd starts Auni's service by itself (Linux). */
async function serviceEnabled(): Promise<boolean> {
  return run("systemctl", ["--user", "is-enabled", "auni"], { timeout: 5_000 }).then(
    ({ stdout }) => stdout.trim() === "enabled",
    () => false,
  );
}

/** What `auni up --always-on` does to this machine, so a test can stand in for it. */
export interface UpHost {
  readonly onTailnet: typeof onTailnet;
  readonly served: typeof served;
  /** Records TAILSCALE_OWNER and WEB_ORIGIN in the owner's settings file (settings.ts). */
  readonly save: (owner: string, origin: string) => void;
  /** Stops the Auni running on this machine, if one is, and installs and starts the service. */
  readonly restartAsService: () => Promise<void>;
  /** Turns on lingering, false where that takes root. Linux only. */
  readonly enableLinger: () => Promise<boolean>;
  /** Runs the serve command: "done", "root" where it takes root that wasn't given, or why not. */
  readonly serve: (command: readonly string[]) => Promise<"done" | "root" | { failed: string }>;
  /** Whether `origin` answers from Auni's door within the wait. */
  readonly reaches: (origin: string) => Promise<boolean>;
  readonly staysOn: typeof staysOn;
  readonly linux: boolean;
}

/** Where Auni is reached always on: this machine's tailnet name, and the port it's served on. */
interface Place {
  readonly name: string;
  readonly port: number;
  readonly address: string;
  /** Whether Tailscale already sends that port to Auni's door, as root may have set it. */
  readonly served: boolean;
}

/**
 * Where Auni would be reached always on here, on the port `asked` or one it picks, with the
 * steps that found it; or the step that says why it can't be. Finding out changes nothing, so a
 * handover asks it before the laptop lets go (handover/take-over.ts).
 */
export async function placeHere(
  asked: number | null,
  host: Pick<UpHost, "onTailnet" | "served"> = { onTailnet, served },
): Promise<{
  readonly place: Place | null;
  readonly owner: string | null;
  readonly steps: UpStep[];
}> {
  const tailnet = await host.onTailnet();
  if ("problem" in tailnet)
    return {
      place: null,
      owner: null,
      steps: [{ step: "tailscale", status: "fix", says: `Nothing changed: ${tailnet.problem}.` }],
    };
  const { login, name } = tailnet;
  const found: UpStep = { step: "tailscale", status: "done", says: `On your tailnet as ${name}.` };
  const routes = await host.served(name);
  const port = portFor(routes, asked);
  if (port === null)
    return {
      place: null,
      owner: login,
      steps: [
        found,
        {
          step: "port",
          status: "fix",
          says:
            asked === null
              ? "Nothing changed: Tailscale serves something on every port Auni tries here. Pick a free one with --port."
              : `Nothing changed: Tailscale already serves something else on port ${asked} of this machine. Pick a free one with --port.`,
        },
      ],
    };
  // Said, since the port is in the address the owner opens.
  const moved = asked === null && port !== 443 && routes.get(port) !== doorRoute();
  return {
    place: {
      name,
      port,
      address: tailnetOrigin(name, port),
      served: routes.get(port) === doorRoute(),
    },
    owner: login,
    steps: [
      found,
      {
        step: "port",
        status: "done",
        says: moved
          ? `Tailscale serves something else on port 443 here, so Auni takes port ${port}.`
          : `Port ${port} is Auni's.`,
      },
    ],
  };
}

/** Sets this machine up as Auni's always-on home, through Tailscale on `asked` or a port it picks. */
export async function up(asked: number | null, host: UpHost): Promise<UpReport> {
  const steps: UpStep[] = [];
  const report = (fields: Partial<Pick<UpReport, "address" | "owner">> = {}) =>
    host.staysOn().then((stays): UpReport => ({
      ok: steps.every(({ status }) => status !== "fix"),
      address: fields.address ?? null,
      owner: fields.owner ?? null,
      machine: hostname(),
      steps,
      staysOn: stays,
    }));

  const found = await placeHere(asked, host);
  steps.push(...found.steps);
  if (!found.place || !found.owner) return report({ owner: found.owner });
  const login = found.owner;
  const { port, address } = found.place;

  host.save(login, address);
  steps.push({
    step: "settings",
    status: "done",
    says: `Auni answers only your Tailscale account (${login}), at ${address}.`,
  });

  const restarted = await host.restartAsService().then(
    () => null,
    (error: unknown) => (error instanceof Error ? error.message : String(error)).split("\n")[0]!,
  );
  if (restarted !== null) {
    steps.push({
      step: "service",
      status: "fix",
      says: `Auni couldn't run as a service of this machine: ${restarted}`,
    });
    return report({ address, owner: login });
  }
  steps.push({ step: "service", status: "done", says: "Auni runs as a service of this machine." });

  if (host.linux)
    steps.push(
      (await host.enableLinger())
        ? { step: "linger", status: "done", says: "It starts at boot, with nobody logged in." }
        : {
            step: "linger",
            status: "fix",
            says: "It stops when you log out, until lingering is on, which takes root.",
            run: `sudo loginctl enable-linger ${userInfo().username}`,
          },
    );

  const command = serveCommand(port);
  // Already sent to the door, by the `sudo` line a run before gave: serving it again would only
  // ask for root once more.
  const served = found.place.served ? "done" : await host.serve(command);
  if (served !== "done") {
    steps.push(
      served === "root"
        ? {
            step: "serve",
            status: "fix",
            says: "Tailscale sends requests to Auni's door, a socket only you and root can open, once root says so.",
            run: `sudo ${command.join(" ")}`,
          }
        : { step: "serve", status: "fix", says: `Tailscale wouldn't serve it: ${served.failed}` },
    );
    return report({ address, owner: login });
  }
  steps.push({ step: "serve", status: "done", says: `Tailscale sends ${address} to Auni.` });

  steps.push(
    (await host.reaches(address))
      ? { step: "reaches", status: "done", says: `${address} answers.` }
      : {
          step: "reaches",
          status: "fix",
          says: `${address} doesn't answer yet: \`auni doctor\` says why (the first start builds the web app, about a minute).`,
        },
  );
  return report({ address, owner: login });
}

/** Runs a serve command: "done", "root" where it takes root that wasn't given, or why not. */
async function serve(
  [command, ...args]: readonly string[],
  interactive: boolean,
): Promise<"done" | "root" | { failed: string }> {
  try {
    await run(command!, args, { timeout: 30_000 });
    return "done";
  } catch (error) {
    const said = String((error as { stderr?: string }).stderr ?? error);
    // Serving a socket takes root, unless Tailscale runs as this user.
    if (!/must be root|sudo/iu.test(said)) return { failed: said.trim().split("\n")[0]! };
    if (!interactive) return "root";
    try {
      execFileSync("sudo", [command!, ...args], { stdio: ["inherit", 2, 2] });
      return "done";
    } catch {
      return "root";
    }
  }
}

/**
 * Doctor's repair (repairs.ts): has Tailscale send WEB_ORIGIN's port to Auni's door again, as
 * `auni up --always-on` set it. It changes no setting, so Auni runs on through it. In a terminal
 * it asks for root there; elsewhere it throws with the line to run.
 */
export async function serveDoorAgain(): Promise<void> {
  const command = serveCommand(Number(new URL(env.WEB_ORIGIN).port || 443));
  const served = await serve(command, process.stdin.isTTY === true);
  if (served === "root") throw new Error(`it takes root: run \`sudo ${command.join(" ")}\``);
  if (served !== "done") throw new Error(served.failed);
}

/**
 * The machine `up` acts on: this one. `interactive` lets it ask for root at this terminal, for the
 * one step that takes it; a coding agent's run (--json) never asks, and says what to run instead.
 */
export function thisMachine(
  host: Pick<UpHost, "save" | "restartAsService">,
  interactive: boolean,
): UpHost {
  return {
    ...host,
    onTailnet,
    served,
    staysOn,
    linux: platform() === "linux",
    // Doctor's repair of the same (service.ts), which says the sudo line where it takes root.
    enableLinger: async () => {
      if (lingers() === true) return true;
      try {
        enableLinger();
      } catch {
        return false;
      }
      return lingers() === true;
    },
    serve: (command) => serve(command, interactive),
    reaches: async (origin) => {
      for (const until = Date.now() + 180_000; Date.now() < until; await sleep(2_000)) {
        const ok = await fetch(`${origin}/core/health`, {
          signal: AbortSignal.timeout(5_000),
        }).then(
          (answer) => answer.ok,
          () => false,
        );
        if (ok) return true;
      }
      return false;
    },
  };
}

/** The report as a person reads it, one line a step. */
export function upSaid(report: UpReport): string {
  const lines = report.steps.map(
    ({ status, says, run }) =>
      `${status === "done" ? "done" : status.padEnd(4)} ${says}${run ? `\n     Run: ${run}` : ""}`,
  );
  const end = report.ok
    ? `\nAuni is always on at ${report.address}: open it on any of your devices signed in to Tailscale.`
    : "\nRun `auni up --always-on` again once that's done.";
  return [...lines, `${report.staysOn.stays ? "done" : "note"} ${report.staysOn.says}`, end].join(
    "\n",
  );
}

/** What doctor says of how this machine reaches the owner and keeps Auni running. */
export interface ReachFinding {
  readonly status: "ok" | "note" | "fix";
  readonly says: string;
  readonly repair?: Finding["repair"];
}

/**
 * Always on, whether Tailscale still brings the owner to Auni's door and the machine keeps Auni
 * running; on this computer, a note of what it keeps and how to change that.
 */
export async function reachFindings(): Promise<ReachFinding[]> {
  const stays = await staysOn();
  if (!env.TAILSCALE_OWNER)
    return [
      {
        status: "note",
        says: "on this computer only: `auni up --always-on` reaches it from your other devices, through Tailscale, on a machine that stays on",
      },
      {
        status: stays.stays ? "ok" : "note",
        says: stays.run ? `${stays.says} Run: ${stays.run}` : stays.says,
      },
    ];
  const again = "run `auni up --always-on` on it again";
  const tailnet = await onTailnet();
  if ("problem" in tailnet) return [{ status: "fix", says: tailnet.problem }];
  const at = new URL(env.WEB_ORIGIN);
  const findings: ReachFinding[] = [];
  const theirs = tailnet.login.toLowerCase() === env.TAILSCALE_OWNER.toLowerCase();
  if (!theirs)
    findings.push({
      status: "fix",
      says: `this machine is signed in to another Tailscale account than the one Auni answers: sign it in with yours, or ${again}`,
    });
  if (tailnet.name !== at.hostname)
    findings.push({
      status: "fix",
      says: `this machine is ${tailnet.name} on the tailnet now, not ${at.hostname}: ${again}`,
    });
  const port = Number(at.port || 443);
  const routes = await served(at.hostname).catch(() => null);
  const route = routes?.get(port);
  if (route !== doorRoute())
    findings.push({
      status: "fix",
      says:
        route === undefined
          ? `Tailscale doesn't send ${env.WEB_ORIGIN} to Auni's door. Run: sudo ${serveCommand(port).join(" ")}`
          : `Tailscale doesn't send ${env.WEB_ORIGIN} to Auni's door${routes ? ", but to something else" : ""}: ${again}`,
      // Put back only where nothing else has the port, on the machine and account Auni answers.
      ...(route === undefined && routes && theirs && tailnet.name === at.hostname
        ? { repair: { id: "tailscale-serve", recommended: true } }
        : {}),
    });
  if (findings.length === 0)
    findings.push({
      status: "ok",
      says: `through Tailscale at ${env.WEB_ORIGIN}, for your account alone`,
    });
  // Lingering is the service check's to say, with its repair (doctor.ts).
  if (stays.repair === "linger") return findings;
  return [
    ...findings,
    {
      // A laptop is a limit worth knowing; a machine that could stay on and doesn't is to fix.
      status: stays.stays ? "ok" : stays.laptop ? "note" : "fix",
      says: stays.run ? `${stays.says} Run: ${stays.run}` : stays.says,
      ...(stays.repair ? { repair: { id: stays.repair, recommended: true } } : {}),
    },
  ];
}

/** How the owner reaches Auni, as the environment switcher and Settings show it (`GET /me`). */
export async function reachWire(): Promise<Me["reach"]> {
  const { stays, laptop, says } = await staysOn();
  const tailscaleName =
    env.TAILSCALE_OWNER && URL.canParse(env.WEB_ORIGIN)
      ? new URL(env.WEB_ORIGIN).hostname.split(".")[0]
      : null;
  return {
    through: env.TAILSCALE_OWNER ? "tailscale" : "this-computer",
    address: env.WEB_ORIGIN,
    owner: env.TAILSCALE_OWNER ?? null,
    machine: tailscaleName || hostname().split(".")[0] || "this computer",
    staysOn: { stays, laptop, says },
  };
}

/**
 * Detailed live Tailscale state on this machine, for Settings -> Remote access and the onboarding
 * wizard. Never mutates anything.
 */
export async function inspectTailscale(): Promise<TailscaleStateWire> {
  const configured = Boolean(env.TAILSCALE_OWNER);
  let status: TailscaleStatus;
  try {
    status = JSON.parse((await run("tailscale", ["status", "--json"], { timeout: 10_000 })).stdout);
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    return {
      state: missing ? "missing" : "stopped",
      dnsName: null,
      login: env.TAILSCALE_OWNER ?? null,
      configured,
      served: false,
      port: null,
      url: configured ? env.WEB_ORIGIN : null,
      problem: missing
        ? "Tailscale isn't installed on this machine yet."
        : "Tailscale isn't running yet. Start Tailscale or run `tailscale up`.",
    };
  }
  if (status.BackendState !== "Running" || !status.Self) {
    return {
      state: "stopped",
      dnsName: null,
      login: env.TAILSCALE_OWNER ?? null,
      configured,
      served: false,
      port: null,
      url: configured ? env.WEB_ORIGIN : null,
      problem: "Tailscale isn't signed in or connected yet. Open Tailscale or run `tailscale up`.",
    };
  }
  const { Self } = status;
  const dnsName = Self.DNSName?.replace(/\.$/u, "") ?? null;
  if (Self.Tags?.length) {
    return {
      state: "tagged",
      dnsName,
      login: null,
      configured,
      served: false,
      port: null,
      url: null,
      problem:
        "This machine uses a Tailscale tag, so Tailscale can't verify your personal login. Re-authenticate with `tailscale up --force-reauth`.",
    };
  }
  const login = status.User?.[String(Self.UserID)]?.LoginName ?? null;
  if (!login || !dnsName) {
    return {
      state: "stopped",
      dnsName,
      login,
      configured,
      served: false,
      port: null,
      url: null,
      problem: "Tailscale didn't report a MagicDNS name or user login for this machine.",
    };
  }
  if (!status.CertDomains?.includes(dnsName)) {
    return {
      state: "https_off",
      dnsName,
      login,
      configured,
      served: false,
      port: null,
      url: null,
      problem:
        "HTTPS certificates are off for your tailnet. Enable MagicDNS and HTTPS Certificates in Tailscale's DNS settings.",
    };
  }
  const routes = await served(dnsName).catch(() => new Map<number, string>());
  const doorEntry = [...routes].find(([, route]) => route === doorRoute());
  const freePort = portFor(routes, null);
  const activePort = doorEntry?.[0] ?? freePort;
  return {
    state: "ready",
    dnsName,
    login,
    configured,
    served: doorEntry !== undefined,
    port: activePort,
    url: activePort !== null ? tailnetOrigin(dnsName, activePort) : null,
    problem:
      activePort === null
        ? "Tailscale is already serving on every port Auni checks (443, 8443+). Pick a custom port."
        : null,
  };
}

/**
 * Enables Tailscale HTTPS for this machine from Settings (step-up gated): first verifies or starts
 * `tailscale serve` non-interactively, and ONLY commits TAILSCALE_OWNER + WEB_ORIGIN once Serve is
 * active so a failed or root-blocked Serve can never lock the owner out on restart.
 */
export async function enableTailscaleFromUi(
  askedPort: number | null,
): Promise<TailscaleEnableResult> {
  const found = await placeHere(askedPort);
  const steps = [...found.steps];
  if (!found.place || !found.owner) {
    return {
      ok: false,
      url: null,
      owner: found.owner,
      needsSudo: false,
      sudoCommand: null,
      needsRestart: false,
      steps,
    };
  }
  const { port, address, served: alreadyServed } = found.place;
  const command = serveCommand(port);
  const result = alreadyServed ? "done" : await serve(command, false);
  let needsSudo = false;
  let sudoCommand: string | null = null;
  if (result === "done") {
    steps.push({
      step: "serve",
      status: "done",
      says: `Tailscale proxies ${address} directly to Auni's unix door.`,
    });
  } else if (result === "root") {
    needsSudo = true;
    sudoCommand = `sudo ${command.join(" ")}`;
    steps.push({
      step: "serve",
      status: "fix",
      says: "Tailscale Serve needs root permission once to proxy to Auni's private unix socket. Run the command below, then enable again to save.",
      run: sudoCommand,
    });
    return {
      ok: false,
      url: address,
      owner: found.owner,
      needsSudo,
      sudoCommand,
      needsRestart: false,
      steps,
    };
  } else {
    steps.push({
      step: "serve",
      status: "fix",
      says: `Tailscale wouldn't serve it: ${result.failed}`,
    });
    return {
      ok: false,
      url: address,
      owner: found.owner,
      needsSudo: false,
      sudoCommand: null,
      needsRestart: false,
      steps,
    };
  }

  // Only persist Tailscale-only owner auth once Serve is confirmed active.
  saveAlwaysOn(found.owner, address);
  steps.push({
    step: "settings",
    status: "done",
    says: `Saved Tailscale access for ${found.owner} at ${address}.`,
  });

  if (platform() === "linux" && lingers() !== true) {
    try {
      enableLinger();
      steps.push({
        step: "linger",
        status: "done",
        says: "Enabled background lingering so Auni keeps running after logout.",
      });
    } catch {
      steps.push({
        step: "linger",
        status: "note",
        says: "To keep Auni running when logged out, enable lingering once.",
        run: `sudo loginctl enable-linger ${userInfo().username}`,
      });
    }
  }

  const needsRestart = env.TAILSCALE_OWNER !== found.owner || env.WEB_ORIGIN !== address;
  return {
    ok: true,
    url: address,
    owner: found.owner,
    needsSudo,
    sudoCommand,
    needsRestart,
    steps,
  };
}

/**
 * Disables Tailscale HTTPS in `~/.auni/.env`. When Auni is currently running in Tailscale mode,
 * the active Tailscale Serve route is intentionally left open until restart so the remote browser
 * reliably receives this response and its restart instructions instead of being cut off mid-flight.
 */
export async function disableTailscaleFromUi(): Promise<{
  readonly ok: boolean;
  readonly needsRestart: boolean;
  readonly serveOffCommand: string | null;
  readonly note: string | null;
}> {
  const wasTailscale = Boolean(env.TAILSCALE_OWNER);
  if (!wasTailscale && setBy("TAILSCALE_OWNER") === null) {
    return { ok: true, needsRestart: false, serveOffCommand: null, note: null };
  }
  const activePort = wasTailscale ? Number(new URL(env.WEB_ORIGIN).port || 443) : null;
  clearAlwaysOn();

  if (wasTailscale && activePort !== null) {
    return {
      ok: true,
      needsRestart: true,
      serveOffCommand: `sudo tailscale serve --https=${activePort} off`,
      note: "Saved local-only mode. Your current Tailscale link stays open until you turn off Serve and restart Auni.",
    };
  }

  return { ok: true, needsRestart: false, serveOffCommand: null, note: null };
}
