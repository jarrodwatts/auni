import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { dataDir } from "../data-dir.ts";
import { byRelease, isReleaseTag } from "./tags.ts";

// Where an installed Auni lives (install.sh writes it; `auni update` adds to it):
//
//   $AUNI_HOME/app/
//     bin/auni                  the launcher; ~/.local/bin/auni links to it
//     node/<node-version>/      a private Node, verified against nodejs.org's SHASUMS256.txt
//     versions/<tag>/           a source tree, installed and built where it stays
//       .auni-release.txt         the release.txt it was installed from, its signature checked
//       .node -> ../../node/<v>   the Node it runs on
//       .auni-built               written last: a folder without it is incomplete
//     current -> versions/<tag> switched atomically
//     backups/<tag>-<utc>/      a cold copy of Auni's own Postgres, taken by `auni update`
//
// A version is never renamed once built, as `next build` and pnpm keep absolute paths. A clone
// run with `pnpm start` is a source checkout: none of this applies to it.

/** This version's source tree: the repo root of a checkout, or `versions/<tag>` of an install. */
export const SOURCE = fileURLToPath(new URL("../../../..", import.meta.url)).replace(/\/$/u, "");

/** Written last into a version's folder, once it's built. */
export const BUILT = ".auni-built";

export const appDir = (): string => join(dataDir(), "app");
const versionsDir = (): string => join(appDir(), "versions");
export const versionDir = (tag: string): string => join(versionsDir(), tag);
export const backupsDir = (): string => join(appDir(), "backups");
/** The launcher install.sh writes, which always runs `current`. */
export const launcher = (): string => join(appDir(), "bin", "auni");
const currentLink = () => join(appDir(), "current");

/** The version this code is, from the root package.json: "0.1.0". */
export function runningVersion(root = SOURCE): string {
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version: string;
  };
  return version;
}

/** Where an installed version keeps the release.txt it was installed from (install.sh). */
const RELEASE_FILE = ".auni-release.txt";

/**
 * The commit this code is, short: the one its release names for an installed version, or the
 * clone's own; null wherever neither can say.
 */
function runningCommit(root = SOURCE): string | null {
  if (existsSync(join(root, RELEASE_FILE))) {
    const commit = /^commit ([0-9a-f]+)$/mu.exec(readFileSync(join(root, RELEASE_FILE), "utf8"));
    return commit ? commit[1]!.slice(0, 9) : null;
  }
  if (!existsSync(join(root, ".git"))) return null;
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

let line: string | undefined;

/** Which Auni this process is: its version, and its commit where one is known ("0.1.0 (5d9832f24)"). */
export function versionLine(): string {
  if (line === undefined) {
    const commit = runningCommit();
    line = commit ? `${runningVersion()} (${commit})` : runningVersion();
  }
  return line;
}

/** Whether `root` (this process's source, unless a test names one) is an installed version. */
export function installed(root = SOURCE): boolean {
  return existsSync(versionsDir()) && realpathSync(dirname(root)) === realpathSync(versionsDir());
}

/** The tag `current` points at, or null when nothing is installed. */
export function currentTag(): string | null {
  return existsSync(currentLink()) ? basename(readlinkSync(currentLink())) : null;
}

/** The versions built in full, oldest first. */
export function listVersions(): string[] {
  if (!existsSync(versionsDir())) return [];
  return readdirSync(versionsDir())
    .filter((tag) => isReleaseTag(tag) && existsSync(join(versionDir(tag), BUILT)))
    .sort(byRelease);
}

/**
 * The command that runs Auni as it runs now, for a service and for `auni update`'s probe: an
 * install's launcher, which always runs `current`, or this checkout's own entry on this Node.
 */
export function selfCommand(root = SOURCE): string[] {
  return installed(root) ? [launcher()] : [process.execPath, join(root, "apps/core/bin/auni.mjs")];
}

/** Points `current` at `tag` in one step: a new link renamed over the old one. */
export function switchCurrent(tag: string): void {
  const next = `${currentLink()}.new`;
  rmSync(next, { force: true });
  symlinkSync(join("versions", tag), next);
  renameSync(next, currentLink());
}
