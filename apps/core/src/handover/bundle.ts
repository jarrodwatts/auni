import { parseEnv } from "node:util";

import { z } from "zod";

import type { WalletKeys } from "../apps/contract.ts";

// What a handover carries from the laptop to the machine that stays on: the whole of Auni,
// sealed (seal.ts) for the one machine the owner gave the code to.
//
//   the database and routines   `auni export`'s file, as db/export.ts writes it
//   the wallet's keys           where the wallet keeps them on this machine (local-key's)
//   the owner's settings        their .env, but for the lines that say how this machine runs Auni

export interface Bundle {
  /** The Auni that packed it, which the new machine's must be as new as. */
  readonly version: string;
  /** The wallet app and its keys, for a wallet that keeps them on this machine; else null. */
  readonly wallet: { readonly app: string; readonly keys: WalletKeys } | null;
  /** The owner's settings file, without the lines only this machine's Auni reads. */
  readonly settings: string;
  /** What `auni export` wrote: gzipped lines of JSON. */
  readonly export: Buffer;
}

const bundleSchema = z.object({
  auni: z.literal("handover"),
  version: z.string(),
  wallet: z
    .object({
      app: z.string(),
      keys: z.object({ evm: z.string().nullable(), solana: z.string().nullable() }),
    })
    .nullable(),
  settings: z.string(),
  export: z.string(),
});

export const packed = (bundle: Bundle): Buffer =>
  Buffer.from(
    JSON.stringify({ auni: "handover", ...bundle, export: bundle.export.toString("base64") }),
  );

/** A bundle's bytes, read; it came through the seal, so only a different Auni makes it fail. */
export function unpacked(bytes: Buffer): Bundle {
  const read = bundleSchema.safeParse(
    (() => {
      try {
        return JSON.parse(bytes.toString("utf8")) as unknown;
      } catch {
        return null;
      }
    })(),
  );
  // Never the parser's own words, which quote what it read: the keys among it.
  if (!read.success) throw new Error("The bundle from your laptop isn't one this Auni can read.");
  return { ...read.data, export: Buffer.from(read.data.export, "base64") };
}

/**
 * The settings that say how this machine runs Auni, not what the owner chose: where it listens,
 * the address it's opened at, its database, its folder, its own secret. The new machine sets its
 * own (`auni up --always-on` writes WEB_ORIGIN).
 */
const THIS_MACHINE = [
  "PORT",
  "HOST",
  "WEB_HOST",
  "WEB_PORT",
  "WEB_ORIGIN",
  "DATABASE_URL",
  "AUNI_HOME",
  "AUNI_RUNS_AS",
  "TURN_TOKEN_SECRET",
];

/**
 * The owner's settings file as it travels: every line as they wrote it, but those that set what
 * only this machine reads. Null when the file can't be cut so cleanly (a value spread over lines
 * that names one of them), so the handover is refused before it starts rather than carry it wrong.
 */
export function carriedSettings(text: string): string | null {
  const assigns = new RegExp(`^\\s*(?:export\\s+)?(?:${THIS_MACHINE.join("|")})\\s*=`, "u");
  const carried = text
    .split("\n")
    .filter((line) => !assigns.test(line))
    .join("\n");
  const [was, now] = [parseEnv(text), parseEnv(carried)];
  const expected = Object.entries(was).filter(([name]) => !THIS_MACHINE.includes(name));
  const same =
    Object.keys(now).length === expected.length &&
    expected.every(([name, value]) => now[name] === value);
  return same ? carried : null;
}
