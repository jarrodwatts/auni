import { execFile } from "node:child_process";

import { z } from "zod";

// The owner's machines as Tailscale lists them (`tailscale status --json`), for handing Auni
// over to one that stays on. Only the owner's own count: a machine shared in from someone else's tailnet,
// or a tagged one (which belongs to no person), is not theirs to hand Auni over to.

export interface Machine {
  /** Tailscale's id for it, which the owner's pick names. */
  readonly id: string;
  /** Its name on the tailnet, the first part of its address: "home-server". */
  readonly name: string;
  /** As Tailscale says it: linux, macOS, windows, iOS, android. */
  readonly os: string;
  readonly online: boolean;
  /** Whether Auni can run there: Linux and macOS, and Windows inside WSL. */
  readonly runsAuni: boolean;
  /**
   * Its full name on the tailnet, "home-server.tail1234.ts.net": the host of the address Auni has
   * there once it runs always on, which the new machine says, port and all (take-over.ts).
   */
  readonly dnsName: string;
  /** Its tailnet addresses, the only ones a handover to it answers. */
  readonly ips: readonly string[];
  /** This machine, the one Auni runs on now. */
  readonly here: boolean;
}

export type Tailnet =
  /** No Tailscale on this machine. */
  | { readonly state: "missing" }
  /** Tailscale is here, but not connected and signed in. */
  | { readonly state: "off" }
  | { readonly state: "on"; readonly here: Machine; readonly machines: readonly Machine[] };

const nodeSchema = z.object({
  ID: z.string(),
  HostName: z.string(),
  DNSName: z.string(),
  OS: z.string(),
  UserID: z.number(),
  TailscaleIPs: z.array(z.string()).nullish(),
  Online: z.boolean().nullish(),
  Tags: z.array(z.string()).nullish(),
  ShareeNode: z.boolean().nullish(),
});

const statusSchema = z.object({
  BackendState: z.string(),
  Self: nodeSchema.nullish(),
  Peer: z.record(z.string(), nodeSchema).nullish(),
});

const RUNS_AUNI = new Set(["linux", "macOS", "windows"]);

function machine(node: z.infer<typeof nodeSchema>, here: boolean): Machine {
  const dns = node.DNSName.replace(/\.$/u, "");
  return {
    id: node.ID,
    name: dns.split(".")[0] || node.HostName,
    os: node.OS,
    online: here || node.Online === true,
    runsAuni: RUNS_AUNI.has(node.OS),
    dnsName: dns,
    ips: node.TailscaleIPs ?? [],
    here,
  };
}

/** The owner's machines in what `tailscale status --json` printed, this one first. */
export function tailnetIn(printed: string): Tailnet {
  let status: z.infer<typeof statusSchema>;
  try {
    status = statusSchema.parse(JSON.parse(printed));
  } catch {
    return { state: "off" };
  }
  const self = status.Self;
  if (status.BackendState !== "Running" || !self) return { state: "off" };
  const owned = Object.values(status.Peer ?? {})
    .filter((node) => node.UserID === self.UserID && !node.Tags?.length && !node.ShareeNode)
    .map((node) => machine(node, false))
    .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  const here = machine(self, true);
  return { state: "on", here, machines: [here, ...owned] };
}

/** Where the Tailscale command is: on the PATH, or inside the macOS app. */
const COMMANDS = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

/** What `tailscale status --json` prints, or null with no Tailscale here; "" when it can't answer. */
type Run = (command: string) => Promise<string | null>;

const run: Run = (command) =>
  new Promise((resolve) =>
    execFile(command, ["status", "--json"], { timeout: 5_000 }, (error, stdout) => {
      if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return resolve(null);
      // Logged out or stopped, it still prints its state; a daemon that isn't running prints none.
      resolve(stdout || "");
    }),
  );

/** The owner's tailnet as this machine sees it now. */
export async function readTailnet(runs: Run = run): Promise<Tailnet> {
  for (const command of COMMANDS) {
    const printed = await runs(command);
    if (printed !== null) return tailnetIn(printed);
  }
  return { state: "missing" };
}
