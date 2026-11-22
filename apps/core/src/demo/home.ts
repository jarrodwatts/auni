import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

// The demo's own home and settings, readied before anything else of Auni loads (cli.ts). This
// file imports nothing of core's, since env.ts reads the environment the moment it is imported.
//
// A demo is a command, never a setting: nothing in a `.env` or the environment turns it on, and
// once it runs, nothing of the owner's is read. Their `~/.auni` and its `.env` are never opened,
// and every variable but the few a program needs to run and open a browser is dropped, so no
// DATABASE_URL, WALLET, BRAIN, RPC or key of theirs reaches this process.

/** What the demo keeps of the environment it was started in: enough to run and open a browser. */
const KEPT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "TMPDIR",
  "TERM",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "BROWSER",
]);

/** The host name each chain's stand-in RPC answers at (world/chain.ts answers there). */
export const rpcHost = (chain: string) => `${chain}.rpc.auni-demo.invalid`;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/**
 * Replaces this process's environment with the demo's, and returns the demo's home: a folder
 * under the system's temporary folder, one per web port, which only a demo ever uses. Whatever an
 * earlier demo left there is removed first, so every demo starts from nothing.
 */
export async function demoEnvironment(
  webPort: number,
  chains: readonly string[],
): Promise<{ readonly home: string; readonly ports: readonly number[] }> {
  const home = join(tmpdir(), `auni-demo-${userInfo().uid}-${webPort}`);
  for (const key of Object.keys(process.env)) if (!KEPT.has(key)) delete process.env[key];
  const corePort = await freePort();
  Object.assign(process.env, {
    AUNI_HOME: home,
    PORT: String(corePort),
    WEB_PORT: String(webPort),
    ...Object.fromEntries(
      chains.map((chain) => [`RPC_URL_${chain.toUpperCase()}`, `https://${rpcHost(chain)}`]),
    ),
  });
  return { home, ports: [corePort, webPort] };
}

/**
 * Stops the Postgres an earlier demo left running on `dataDir`, if one still is. The first line of
 * postmaster.pid names the server's process, but the file outlives a demo killed hard, and by now
 * the number may be any process of this person's. So it is signalled only if it is a postgres
 * started on this very folder (`pg_ctl` checks no such thing). SIGQUIT stops a server at once.
 */
function stopLeftPostgres(dataDir: string): void {
  let pid: number;
  try {
    pid = Number(readFileSync(join(dataDir, "postmaster.pid"), "utf8").split("\n")[0]);
  } catch {
    return; // No server was left there.
  }
  if (!Number.isInteger(pid) || pid <= 0) return;
  let command: string;
  try {
    command = execFileSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" });
  } catch {
    return; // Nothing runs as that process now.
  }
  if (/(^|\/)postgres /u.test(command) && command.includes(` -D ${dataDir} `))
    process.kill(pid, "SIGQUIT");
}

/**
 * Stops what an earlier demo left running in `home` and removes it, with the agent's scratch
 * folder beside it. A home that is not a plain folder of this person's (a link, a file, another
 * person's folder in a shared temporary folder) is never one a demo made, so it is refused, not
 * read or followed.
 */
function clear(home: string): void {
  const found = lstatSync(home, { throwIfNoEntry: false });
  if (found && (!found.isDirectory() || found.uid !== userInfo().uid))
    throw new Error(
      `${home} is not a folder an earlier demo left, so the demo won't use or remove it. ` +
        "Remove it yourself, or start the demo on another --port.",
    );
  if (found) stopLeftPostgres(join(home, "postgres"));
  for (const folder of [home, `${home}-work`]) rmSync(folder, { recursive: true, force: true });
}

/**
 * Makes `home` this demo's: whatever an earlier demo left there goes, its Postgres included, and
 * the home goes again when this process ends, however it ends, unless a later demo has taken it
 * since. So a demo never leaves a database server running on files that are gone.
 */
export function takeHome(home: string): void {
  const mark = join(home, "demo.pid");
  clear(home);
  // Not `recursive`, so a folder made here by anyone since the line above is refused, not used.
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(mark, String(process.pid));
  process.on("exit", () => {
    try {
      if (readFileSync(mark, "utf8") === String(process.pid)) clear(home);
    } catch {
      // The home is gone, or another demo's.
    }
  });
}
