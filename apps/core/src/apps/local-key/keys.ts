import type { webcrypto } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { AsyncEntry } from "@napi-rs/keyring";
import {
  createKeyPairFromBytes,
  createKeyPairFromPrivateKeyBytes,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase58Encoder,
} from "@solana/kit";
import { sql } from "drizzle-orm";
import { isHex } from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { z } from "zod";

import { db } from "../../db/client.ts";
import { dataDir } from "../../data-dir.ts";
import type { KeptKeys, WalletAddresses, WalletKeys } from "../contract.ts";

// The owner's keys live here and nowhere else in Auni: never logged, never in an error, never
// within the agent's reach (agent/box.ts hides the data folder and the keychain from its shell).
// Only revealKeys gives them out.

/** The OS keychain's entry, as @napi-rs/keyring gives it; tests stand one in. */
export interface KeychainEntry {
  getPassword(): Promise<string | null>;
  setPassword(password: string): Promise<void>;
  /** Removes the entry: false when there was none. */
  deletePassword(): Promise<boolean>;
}

/** Where the keys are kept, and how they're read and written. */
export interface KeyStore {
  read(): Promise<WalletKeys | null>;
  /** Writes the keys, never over keys already there. */
  write(keys: WalletKeys): Promise<void>;
  /**
   * Writes `keys` in place of the ones kept, refusing unless it keeps each of them unchanged: a
   * key is only ever added. Where the file holds them it is replaced whole, by a rename, so a
   * crash leaves the old keys or the new, never neither.
   */
  add(keys: WalletKeys): Promise<void>;
  /** Where the keys are, said without them; null while there are none. */
  where(): Promise<KeptKeys | null>;
  /** Removes the keys for good, from the keychain and the file: the wallet is lost with them. */
  remove(): Promise<void>;
}

const FILE = "wallet-keys.json";

/** The keychain service Auni's entries sit under. */
const SERVICE = "auni";

/**
 * What the file holds once the keys went to the keychain: the entry's name, so a later run
 * reads that one, wherever the folder has moved since.
 */
const pointerTo = (account: string) => ({ keychain: `${SERVICE}/${account}` });
const pointerSchema = z.object({
  keychain: z
    .string()
    .startsWith(`${SERVICE}/`)
    .transform((name) => name.slice(`${SERVICE}/`.length)),
});

const keysSchema = z.object({
  evm: z
    .string()
    .refine((key) => isHex(key) && key.length === 66, "an EVM key is 32 bytes of hex")
    .nullable(),
  solana: z.string().min(1).nullable(),
});

/**
 * Stored keys, read without ever putting what was stored into an error: JSON.parse quotes the
 * text it fails on.
 */
function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Auni's stored wallet keys are unreadable.");
  }
}

function keysIn(found: unknown): WalletKeys {
  const keys = keysSchema.safeParse(found);
  if (!keys.success) throw new Error("Auni's stored wallet keys are unreadable.");
  return keys.data;
}

/**
 * The keys' store under `dir`. Once the file exists, it decides where the keys are: in it, or
 * (when it says so) in the OS keychain, so where they live never flips between runs, say when
 * the keychain is out of reach over ssh. Before then, keys go to the keychain where one answers,
 * and to the file, readable by this user alone, where none does (Docker, a headless server), or
 * where `newKeys` says "file": a keychain entry outlives the folder, so only the owner's own Auni
 * puts new keys there (machineKeyStore).
 */
export function keyStore(
  dir: string,
  keychain: (account: string) => KeychainEntry,
  { newKeys = "keychain" }: { readonly newKeys?: "keychain" | "file" } = {},
): KeyStore {
  const path = join(dir, FILE);
  // The file's next version, written beside it before it's renamed over it (replaceFile).
  const next = `${path}.new`;
  // Each data folder's own entry, so two installs on one machine never share, or replace, keys.
  const own = `wallet-keys:${resolve(dir)}`;

  const kept = async (): Promise<unknown> => {
    try {
      return parsed(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };

  /** The keychain entry the file points to, or null when it holds the keys itself. */
  const pointedTo = (found: unknown): string | null => {
    if (typeof found !== "object" || found === null || !("keychain" in found)) return null;
    const pointer = pointerSchema.safeParse(found);
    if (!pointer.success) throw new Error("Auni's stored wallet keys are unreadable.");
    return pointer.data.keychain;
  };

  // A keychain answering at all, even with nothing kept, is one Auni can keep keys in.
  const answering = async (): Promise<KeychainEntry | null> => {
    if (newKeys === "file") return null;
    try {
      const entry = keychain(own);
      await entry.getPassword();
      return entry;
    } catch {
      return null;
    }
  };

  const writeFile = async (contents: string) => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Never over a file someone else wrote first.
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
  };

  /** The file, replaced whole: written beside it, then renamed over it. */
  const replaceFile = async (contents: string) => {
    await rm(next, { force: true });
    const file = await open(next, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(next, path);
    const folder = await open(dir, "r");
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  };

  const toKeychain = async (entry: KeychainEntry, keys: WalletKeys) => {
    const secret = JSON.stringify(keys);
    await entry.setPassword(secret);
    if ((await entry.getPassword()) !== secret)
      throw new Error("The OS keychain didn't keep Auni's wallet keys.");
  };

  /** The keychain entry the keys are in, by its name, or null when the file holds them. */
  const entryOf = async (found: unknown): Promise<string | null> => {
    if (found !== null) return pointedTo(found);
    // No file: keys this folder's entry kept before it was lost are where read() finds them.
    return (await (await answering())?.getPassword()) ? own : null;
  };

  const read = async (): Promise<WalletKeys | null> => {
    const found = await kept();
    if (found === null) {
      // Keys this folder's entry kept before the file was lost are still the owner's.
      const left = await (await answering())?.getPassword();
      if (!left) return null;
      const keys = keysIn(parsed(left));
      await writeFile(JSON.stringify(pointerTo(own)));
      return keys;
    }
    const account = pointedTo(found);
    if (account === null) return keysIn(found);
    const secret = await Promise.resolve()
      .then(() => keychain(account).getPassword())
      .catch((error: unknown) => {
        throw new Error(
          `Auni's wallet keys are in the OS keychain, which can't be read now (${String(error)}). Run Auni where the keychain is unlocked.`,
        );
      });
    if (!secret)
      throw new Error("Auni's wallet keys were in the OS keychain, and it has lost them.");
    return keysIn(parsed(secret));
  };

  return {
    read,

    async write(keys) {
      const entry = await answering();
      if (!entry) return writeFile(JSON.stringify(keys));
      await toKeychain(entry, keys);
      await writeFile(JSON.stringify(pointerTo(own)));
    },

    async add(keys) {
      const before = await read();
      if (!before) throw new Error("There are no wallet keys here to add to.");
      if (
        (before.evm && before.evm !== keys.evm) ||
        (before.solana && before.solana !== keys.solana)
      )
        throw new Error("A wallet key is only ever added, never replaced.");
      const account = pointedTo(await kept());
      if (account === null) return replaceFile(JSON.stringify(keys));
      await toKeychain(keychain(account), keys);
    },

    async where() {
      const found = await kept();
      const account = await entryOf(found);
      if (account !== null)
        return {
          place: `in the OS keychain, as "${account}" under "${SERVICE}"`,
          inDataFolder: false,
        };
      return found === null
        ? null
        : { place: `in ${path}, readable by this user alone`, inDataFolder: true };
    },

    async remove() {
      const account = await entryOf(await kept());
      // The entry first. Cut off between the two, a file is left pointing at nothing, which says
      // the keys are gone; the other way round, an entry would be left with no file, and the
      // next Auni in this folder would take it up again as the owner's keys.
      if (account !== null) await keychain(account).deletePassword();
      await rm(path, { force: true });
      // An add cut off before its rename left the keys here too.
      await rm(next, { force: true });
    },
  };
}

/**
 * The store this machine keeps the owner's keys in. New keys go to the OS keychain only for the
 * owner's own Auni, the one in ~/.auni: any other data folder (AUNI_HOME) is a second Auni, a
 * test's or a demo's or one tried out for an hour, and its keys stay in its own file, so they go
 * when the folder does instead of sitting in the keychain with nothing pointing at them. Keys a
 * file already points to are read wherever the folder has moved.
 */
export function machineKeyStore(): KeyStore {
  const dir = dataDir();
  const own = resolve(dir) === resolve(homedir(), ".auni");
  return keyStore(dir, osKeychain, { newKeys: own ? "keychain" : "file" });
}

/**
 * An entry of the OS keychain. On Linux, the Secret Service's only (GNOME Keyring, KWallet...):
 * left to itself the library falls back to the kernel's keyring, which is memory that a reboot
 * clears, and keys kept there would be lost with the wallet's money.
 */
const osKeychain = (account: string): KeychainEntry =>
  new AsyncEntry(SERVICE, account, { linux: { store: "secret-service" } });

/** A new EVM key and Solana key, each from the system's secure random source. */
export async function generateKeys(): Promise<WalletKeys> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pair = await createKeyPairFromPrivateKeyBytes(seed);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  // Solana's usual secret: the 32-byte seed, then its 32-byte public key, in base58.
  const secret = new Uint8Array([...seed, ...publicKey]);
  return { evm: generatePrivateKey(), solana: getBase58Decoder().decode(secret) };
}

/** A Solana key pair, as WebCrypto holds it (core has no DOM types, where @solana/kit names it). */
export type SolanaKeyPair = webcrypto.CryptoKeyPair;

/** The Solana key pair a stored secret holds, checked: its public half must match its private. */
export function solanaKeyPair(secret: string): Promise<SolanaKeyPair> {
  return createKeyPairFromBytes(getBase58Encoder().encode(secret));
}

/** The addresses keys sign for. */
export async function addressesOf(keys: WalletKeys): Promise<WalletAddresses> {
  return {
    evm: keys.evm ? privateKeyToAddress(keys.evm as `0x${string}`) : null,
    solana: keys.solana
      ? await getAddressFromPublicKey((await solanaKeyPair(keys.solana)).publicKey)
      : null,
  };
}

/**
 * Runs `fn` holding the lock on the owner's keys, across every process on this database, so
 * whatever writes keys reads the store again under it first and two never make two wallets.
 */
export function withKeysLocked<T>(fn: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('auni:wallet-keys'))`);
    return fn();
  });
}
