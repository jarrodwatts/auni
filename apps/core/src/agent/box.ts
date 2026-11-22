import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { dataDir } from "../data-dir.ts";

/**
 * What the agent's own tools (its shell, its file reader) may touch on the owner's machine. The
 * agent does whatever what it reads tells it to, so it must never reach the wallet keys, the
 * database, the owner's session or a CLI's login. Each brain enforces its box with its own CLI's
 * sandbox; Auni's tools, which do the real work, run in core and are reached over MCP.
 */
export interface Box {
  /** The agent's one scratch folder, readable by this user alone: its shell starts here. */
  readonly workDir: string;
  /** Nothing under these can be read. */
  readonly hidden: readonly string[];
  /** Readable even inside what's hidden. */
  readonly readable: readonly string[];
}

/**
 * The agent's one scratch folder, made on first use. A CLI also starts here when core only asks
 * it something, since it leaves files of its own wherever it starts. It sits beside the data
 * folder, never in it, so a box hides the data folder whole: Codex can't reopen a folder inside
 * one it hides, and hiding the data folder entry by entry instead would miss a file made there
 * mid-turn, such as the keys file on a first move.
 */
export function scratchDir(): string {
  const dir = `${dataDir().replace(/\/+$/u, "")}-work`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

const REPO_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));

/** Whether `path` is `dir` or inside it, however either is spelled through links. */
function within(path: string, dir: string): boolean {
  const [real, root] = [path, dir].map((each) => (existsSync(each) ? realpathSync(each) : each));
  return real === root || real!.startsWith(`${root}/`);
}

/**
 * Hiding home hides most of it at once: the data folder with its keys file and the owner's
 * `.env`, the repo, the CLIs' logins, ssh keys and the browser profile holding the owner's
 * session. The rest covers installs outside home, what `alsoHidden` names (every CLI's login, the
 * database's own files), and the session bus (/run/user/<uid>), which is the door to the OS
 * keychain and the ssh agent. Node's own install stays readable for the agent's scripts, but for
 * an install's private Node, which sits in the data folder: nothing in it is ever readable, so a
 * box hides the data folder whole (see scratchDir), and the agent's shell has no Node there.
 */
export function theBox(alsoHidden: readonly string[]): Box {
  const workDir = scratchDir();
  const node = dirname(dirname(process.execPath));
  return {
    workDir,
    hidden: [
      ...new Set([
        homedir(),
        dataDir(),
        REPO_ROOT.replace(/\/$/u, ""),
        ...alsoHidden,
        `/run/user/${userInfo().uid}`,
      ]),
    ],
    readable: within(node, dataDir()) ? [workDir] : [workDir, node],
  };
}
