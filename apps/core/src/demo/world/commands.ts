import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

// The commands core runs, as the demo has them: its own, first on its PATH, so the person's
// real ones are never run.
//
// Core reads the owner's machines by running `tailscale status --json` (handover/tailnet.ts):
// the demo's prints a made-up tailnet, so the person's real machines are never read or shown.
// This laptop's address is this machine's own, so a handover offered in the demo listens here
// alone.
//
// Core asks GitHub whether the owner starred Auni, and stars it, by running `gh api`
// (github-star.ts): the demo's answers "not starred" until it is asked to star, and "starred"
// after, and reaches no GitHub account.

const OWNER = 7;
const machine = (id: string, name: string, os: string, ip: string, online: boolean) => ({
  ID: id,
  HostName: name,
  DNSName: `${name}.tail-demo.ts.net.`,
  OS: os,
  UserID: OWNER,
  TailscaleIPs: [ip],
  Online: online,
});

const STATUS = {
  BackendState: "Running",
  Self: machine("nDemoLaptop", "laptop", "macOS", "127.0.0.1", true),
  Peer: {
    a: machine("nDemoServer", "home-server", "linux", "100.100.0.2", true),
    b: machine("nDemoMini", "mac-mini", "macOS", "100.100.0.3", false),
    c: machine("nDemoPhone", "phone", "iOS", "100.100.0.4", true),
  },
};

const quoted = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;

// A PUT stars; any other call answers as GitHub does for a star given (204) or not (404).
const gh = (starred: string) => `#!/bin/sh
case " $* " in
  *" PUT "*) touch ${quoted(starred)}; exit 0 ;;
esac
[ -e ${quoted(starred)} ] && exit 0
echo 'gh: Not Found (HTTP 404)' >&2
exit 1
`;

/** Puts the demo's `tailscale` and `gh` in `home`, first on this process's PATH (and its children's). */
export function standInForCommands(home: string): void {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true, mode: 0o700 });
  const status = join(bin, "tailnet.json");
  writeFileSync(status, JSON.stringify(STATUS));
  const commands = {
    tailscale: `#!/bin/sh\nexec cat ${quoted(status)}\n`,
    gh: gh(join(bin, "starred")),
  };
  for (const [name, script] of Object.entries(commands)) {
    writeFileSync(join(bin, name), script);
    chmodSync(join(bin, name), 0o700);
  }
  process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
}
