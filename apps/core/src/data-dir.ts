import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Read from the environment itself, not env.ts: `auni` needs the data folder before env.ts may
// parse, since the database it starts there is what DATABASE_URL then names (cli.ts).

/**
 * Auni's home folder, which holds what lives on this machine (the owner's settings in `.env`, the
 * database, wallet keys when no OS keychain holds them, its own secrets, and an install's `app/`):
 * AUNI_HOME, or ~/.auni. Readable by the owner alone, and hidden whole from the agent's box
 * (agent/box.ts).
 */
export function dataDir(): string {
  return process.env.AUNI_HOME?.trim() || join(homedir(), ".auni");
}

/**
 * Auni's own tools folder: an AI CLI Auni installed for the owner from the web app (Codex), which
 * Auni finds after their PATH. It sits beside the data folder, as the agent's scratch folder does
 * (agent/box.ts), since a brain's box must read the CLI it runs but hides the data folder whole.
 */
export function toolsDir(): string {
  return `${dataDir().replace(/\/+$/u, "")}-tools`;
}

/**
 * Auni's own output where no terminal reads it: a service's (on a Mac), a background Auni's, and,
 * once its start has played, the working lines of an Auni run in a terminal (hello/telling.ts).
 */
export const auniLog = (): string => join(dataDir(), "auni.log");

/** The owner's settings, read as Auni starts (boot.ts): a version's own folder is replaced on update. */
export function envFile(): string {
  return join(dataDir(), ".env");
}

/** The settings file as the owner writes its path, with their home folder as "~": "~/.auni/.env". */
export function settingsFile(): string {
  const path = envFile();
  const home = homedir();
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** A random secret kept in the data folder as `name`, made the first time it's asked for. */
export function keptSecret(name: string): string {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const file = join(dataDir(), name);
  try {
    writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return readFileSync(file, "utf8").trim();
}
