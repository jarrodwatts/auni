import { spawn } from "node:child_process";
import { once } from "node:events";

import { readRelease, type Release } from "./manifest.ts";
import { isReleaseTag } from "./tags.ts";

/** Why a release wasn't taken, in install.sh's words for the owner. */
export class ReleaseRefused extends Error {}

/**
 * The newest release, or `version`, once the installer of the version running has checked it:
 * signed by a release key that installer lists, and no older than what's installed. That
 * installer is the one checker, for a first install and every update after it (install.sh).
 */
export async function checkRelease({
  installer,
  env,
  version,
}: {
  readonly installer: string;
  readonly env: NodeJS.ProcessEnv;
  readonly version?: string;
}): Promise<Release> {
  // Unnamed is the newest, whatever AUNI_VERSION the owner's shell has.
  const asked: NodeJS.ProcessEnv = { ...env };
  delete asked.AUNI_VERSION;
  delete asked.AUNI_SOURCE;
  if (version) asked.AUNI_VERSION = version;
  return readRelease(await askInstaller(installer, asked));
}

/**
 * The tag of the source AUNI_SOURCE names (`env`'s), as that installer reads it: what its
 * package.json says, "v0.1.1". The installer that builds a source is the one that names it.
 */
export async function sourceTag({
  installer,
  env,
}: {
  readonly installer: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<string> {
  const asked: NodeJS.ProcessEnv = { ...env };
  delete asked.AUNI_VERSION;
  const tag = (await askInstaller(installer, asked)).trim();
  if (!isReleaseTag(tag))
    throw new ReleaseRefused(
      `AUNI_SOURCE says it is "${tag}", which isn't a version such as v0.1.0.`,
    );
  return tag;
}

/** What the installer prints in its checking mode (AUNI_CHECK=1); ReleaseRefused with its reason. */
async function askInstaller(installer: string, env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn("sh", [installer], {
    env: { ...env, AUNI_CHECK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
  // "close", not "exit": "exit" can come before all the installer printed has been read.
  const [code] = (await once(child, "close")) as [number | null];
  if (code !== 0) {
    const said = Buffer.concat(err).toString().trim().split("\n").at(-1) ?? "";
    throw new ReleaseRefused(
      said ? said[0]!.toUpperCase() + said.slice(1) : "The release check failed.",
    );
  }
  return Buffer.concat(out).toString();
}
