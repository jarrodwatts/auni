import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { dataDir } from "../data-dir.ts";

// The owner's routines: ways of working they asked Auni to keep, each a skill file in the data
// folder (<dataDir>/routines/<name>/SKILL.md) in the Agent Skills format, so the owner can read,
// edit or delete one as a plain file. Only their tap on a save_routine card writes one (asks.ts):
// the agent's box hides the whole data folder (box.ts), so it can't write one itself. They are
// read fresh on every turn, so an edit or a delete counts at once.

export function routinesDir(): string {
  return join(dataDir(), "routines");
}

/** A routine as load_skill offers it. */
interface Routine {
  readonly name: string;
  readonly description: string;
  /** What it says, after its frontmatter. */
  readonly body: string;
}

/** Agent Skills' rule for a skill's name, which is also its folder's. */
export const routineNameSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u, "lowercase words joined by hyphens, like check-rates");

/** One line, as frontmatter holds it. */
export const routineDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .transform((text) => text.replace(/\s+/gu, " "));

export const routineBodySchema = z.string().trim().min(1).max(4_000);

/** The file as written: frontmatter, then the body. The description is quoted, so any words fit. */
function routineFile(routine: Routine): string {
  return `---\nname: ${routine.name}\ndescription: ${JSON.stringify(routine.description)}\n---\n\n${routine.body}\n`;
}

/** A file read back, or null when it isn't a routine (the owner may have edited it by hand). */
export function parseRoutine(folder: string, text: string): Routine | null {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(text);
  if (!match) return null;
  const field = (key: string) => new RegExp(`^${key}: (.+)$`, "mu").exec(match[1]!)?.[1]?.trim();
  const name = field("name");
  const raw = field("description");
  let description = raw;
  if (raw?.startsWith('"')) {
    try {
      description = String(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  const body = match[2]!.trim();
  if (name !== folder || !routineNameSchema.safeParse(name).success || !description || !body)
    return null;
  return { name, description, body };
}

/** Every routine on disk, by name; a file that isn't one is skipped and said. */
export function readRoutines(): Routine[] {
  let folders;
  try {
    folders = readdirSync(routinesDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  return folders
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const path = join(routinesDir(), entry.name, "SKILL.md");
      let text;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return [];
      }
      const routine = parseRoutine(entry.name, text);
      if (!routine)
        console.warn(
          `${path} isn't a routine (a name matching its folder, a description and a body), so it's skipped`,
        );
      return routine ? [routine] : [];
    })
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/**
 * What the file under a routine's name holds now, as a digest, or null when there is none. A
 * save_routine card records it when it's shown, so a tap saves only over what that card said it
 * replaces, never over a routine saved or edited by hand since.
 */
export function routineOnDisk(name: string): string | null {
  let text;
  try {
    text = readFileSync(join(routinesDir(), name, "SKILL.md"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Writes a routine, replacing one of that name: to a temp file renamed into place, so a reader
 * never sees half of one, readable by the owner alone.
 */
export function writeRoutine(routine: Routine): void {
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  const folder = join(routinesDir(), routine.name);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temp = join(folder, `.SKILL.md.${randomBytes(6).toString("hex")}`);
  writeFileSync(temp, routineFile(routine), { mode: 0o600 });
  renameSync(temp, join(folder, "SKILL.md"));
}

/** A routine's name as a person reads it: its file is "friday-check", its card says "Friday check". */
export function routineTitle(name: string): string {
  const words = name.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
