import { existsSync, readFileSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { dataDir } from "../data-dir.ts";

// Two files in the data folder say this folder's Auni isn't the one that runs, so it starts no
// job, signs nothing and never runs beside the Auni that went on:
//
//   handed-over.json  the laptop's, once the new machine took Auni over: where it went. Written
//                     once, never removed by Auni: only the owner's removing this copy ends it.
//   taking-over.sealed  the new machine's, while Auni is on its way in: the sealed bundle,
//                     kept until everything in it is in place, so a takeover cut off midway
//                     can finish.

export interface HandedOver {
  /** Where Auni is now: the new machine's address. */
  readonly to: string;
  /** The new machine's name on the tailnet. */
  readonly machine: string;
  readonly at: string;
}

const handedOverSchema = z.object({ to: z.string(), machine: z.string(), at: z.string() });

const handedOverFile = () => join(dataDir(), "handed-over.json");

/** The sealed bundle a takeover keeps here until it's all in place (take-over.ts). */
export const takingFile = (): string => join(dataDir(), "taking-over.sealed");

/** Where this folder's Auni moved to, or null while it is the one that runs. */
export function handedOver(): HandedOver | null {
  if (!existsSync(handedOverFile())) return null;
  const read = handedOverSchema.safeParse(
    (() => {
      try {
        return JSON.parse(readFileSync(handedOverFile(), "utf8")) as unknown;
      } catch {
        return null;
      }
    })(),
  );
  // Unreadable, it still says Auni moved: the safe reading is that this one runs nothing.
  return read.success ? read.data : { to: "", machine: "another machine", at: "" };
}

/** Writes `handed-over.json` and makes sure it's on the disk before this resolves: the handover's commit. */
export async function markHandedOver(handed: HandedOver): Promise<void> {
  await mkdir(dataDir(), { recursive: true, mode: 0o700 });
  const file = await open(handedOverFile(), "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(handed));
    await file.sync();
  } finally {
    await file.close();
  }
  const folder = await open(dataDir(), "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}

/** Whether Auni is on its way into this folder from the laptop, and not yet in place. */
export const takingOver = (): boolean => existsSync(takingFile());
