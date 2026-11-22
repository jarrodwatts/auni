import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { scratchDir } from "../../agent/box.ts";
import { toolsDir } from "../../data-dir.ts";
import { CODEX_PACKAGE } from "./options.ts";

/** What npm last said, kept to say why an install failed. */
const SAID_CHARS = 400;

/**
 * Installs Codex from npm into Auni's own tools folder, as `npm install -g` would into the
 * owner's, so codexCommand finds it there (`<tools>/bin/codex`) with its platform binary inside
 * its own package folder, the one install a turn's box opens. It runs npm with the Node Auni runs
 * on, so it needs nothing on the PATH, and hands it only what it needs of core's environment.
 */
export async function install(signal: AbortSignal): Promise<void> {
  const prefix = toolsDir();
  mkdirSync(prefix, { recursive: true, mode: 0o700 });
  const npm = join(
    dirname(dirname(process.execPath)),
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const args = [
    npm,
    "install",
    "--global",
    "--prefix",
    prefix,
    "--no-fund",
    "--no-audit",
    CODEX_PACKAGE,
  ];
  const env = Object.fromEntries(
    ["PATH", "HOME", "USER", "LANG", "TMPDIR"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
  const child = spawn(process.execPath, args, {
    env,
    cwd: scratchDir(),
    stdio: ["ignore", "ignore", "pipe"],
    signal,
  });
  let said = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => (said = (said + data).slice(-SAID_CHARS)));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    const last = said.trim().split("\n").at(-1);
    throw new Error(`npm couldn't install Codex${last ? `: ${last}` : "."}`);
  }
}
