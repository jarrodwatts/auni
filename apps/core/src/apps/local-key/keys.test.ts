import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getBase58Encoder } from "@solana/kit";
import { privateKeyToAddress } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { tempDir } from "../../test/temp-dir.ts";
import {
  addressesOf,
  generateKeys,
  keyStore,
  machineKeyStore,
  type KeychainEntry,
} from "./keys.ts";

/** The OS keychain machineKeyStore opens, stood in: every entry it opens, and what it holds. */
const os = vi.hoisted(() => ({
  opened: [] as unknown[][],
  held: new Map<string, string>(),
}));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    readonly account: string;
    constructor(...args: [string, string, unknown]) {
      os.opened.push(args);
      this.account = args[1];
    }
    async getPassword() {
      return os.held.get(this.account) ?? null;
    }
    async setPassword(password: string) {
      os.held.set(this.account, password);
    }
    async deletePassword() {
      return os.held.delete(this.account);
    }
  },
}));

const scratch = () => tempDir("auni-keys-");
const KEYS = {
  evm: "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
  solana: null,
} as const;

/** A keychain that answers, holding what it's given. */
function keychain(): KeychainEntry & { held: string | null; asked: number } {
  return {
    held: null,
    asked: 0,
    async getPassword() {
      this.asked += 1;
      return this.held;
    },
    async setPassword(password) {
      this.held = password;
    },
    async deletePassword() {
      const had = this.held !== null;
      this.held = null;
      return had;
    },
  };
}

/** One keychain holding an entry per account name, as the OS's does. */
function keychainOfEntries() {
  const entries = new Map<string, ReturnType<typeof keychain>>();
  return (account: string) => {
    if (!entries.has(account)) entries.set(account, keychain());
    return entries.get(account)!;
  };
}

const none = (): KeychainEntry => {
  throw new Error("No Secret Service on this machine.");
};

describe("keyStore", () => {
  it("keeps keys in a file only this user can read when no keychain answers", async () => {
    const dir = join(scratch(), "data");
    const store = keyStore(dir, none);
    expect(await store.read()).toBeNull();

    await store.write(KEYS);

    expect(await store.read()).toEqual(KEYS);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "wallet-keys.json"))).mode & 0o777).toBe(0o600);
  });

  it("keeps keys in a keychain that answers, and reads them there however the file is moved", async () => {
    const dir = scratch();
    const entry = keychain();
    const store = keyStore(dir, () => entry);

    await store.write(KEYS);

    expect(JSON.parse(entry.held!)).toEqual(KEYS);
    expect(await readFile(join(dir, "wallet-keys.json"), "utf8")).not.toContain(KEYS.evm);
    expect(await store.read()).toEqual(KEYS);
  });

  // Over ssh, say, the keychain may be out of reach: that's no reason to make a second wallet.
  it("never flips: keys in the keychain stay there while it can't be read", async () => {
    const dir = scratch();
    const entry = keychain();
    await keyStore(dir, () => entry).write(KEYS);

    await expect(keyStore(dir, none).read()).rejects.toThrow(/keychain, which can't be read now/u);
  });

  it("never flips: keys in the file stay there once a keychain answers", async () => {
    const dir = scratch();
    await keyStore(dir, none).write(KEYS);
    const entry = keychain();

    expect(await keyStore(dir, () => entry).read()).toEqual(KEYS);
    expect(entry.asked).toBe(0);
  });

  it("finds keys a keychain kept after the file that pointed there was lost", async () => {
    const entry = keychain();
    entry.held = JSON.stringify(KEYS);
    const dir = scratch();

    expect(await keyStore(dir, () => entry).read()).toEqual(KEYS);
    expect(
      await keyStore(dir, none)
        .write(KEYS)
        .catch((error: unknown) => error),
    ).toMatchObject({
      code: "EEXIST",
    });
  });

  // A dev checkout and the real install on one machine must not sign with, or replace, one wallet.
  it("keeps each data folder's keys apart in one keychain", async () => {
    const machine = keychainOfEntries();
    const first = keyStore(scratch(), machine);
    await first.write(KEYS);

    const second = keyStore(scratch(), machine);
    expect(await second.read()).toBeNull();
    const other = { evm: null, solana: "x" };
    await second.write(other);
    expect(await first.read()).toEqual(KEYS);
    expect(await second.read()).toEqual(other);
  });

  it("reads keys from the keychain entry its file names", async () => {
    const machine = keychainOfEntries();
    machine("wallet-keys").held = JSON.stringify(KEYS);
    const dir = scratch();
    await writeFile(
      join(dir, "wallet-keys.json"),
      JSON.stringify({ keychain: "auni/wallet-keys" }),
    );

    expect(await keyStore(dir, machine).read()).toEqual(KEYS);
  });

  it("never writes over keys already there", async () => {
    const dir = scratch();
    const store = keyStore(dir, none);
    await store.write(KEYS);
    await expect(store.write({ evm: null, solana: "x" })).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await store.read()).toEqual(KEYS);
  });

  // A wallet brought with its EVM key alone gains a Solana key beside it, in Settings.
  it("adds a key beside the ones kept, in the file or the keychain, never replacing one", async () => {
    const both = { ...KEYS, solana: (await generateKeys()).solana };
    const dir = scratch();
    const store = keyStore(dir, none);
    await store.write(KEYS);
    await store.add(both);
    expect(await store.read()).toEqual(both);
    expect((await stat(join(dir, "wallet-keys.json"))).mode & 0o777).toBe(0o600);
    await expect(store.add({ ...both, solana: "another" })).rejects.toThrow(
      "A wallet key is only ever added, never replaced.",
    );
    await expect(store.add({ evm: null, solana: both.solana })).rejects.toThrow(
      "A wallet key is only ever added, never replaced.",
    );
    expect(await store.read()).toEqual(both);

    const inKeychain = keyStore(scratch(), keychainOfEntries());
    await inKeychain.write(KEYS);
    await inKeychain.add(both);
    expect(await inKeychain.read()).toEqual(both);

    await expect(keyStore(scratch(), none).add(both)).rejects.toThrow(
      "There are no wallet keys here to add to.",
    );
  });

  it("says where the keys are without them, in the file or the keychain", async () => {
    const inFile = scratch();
    expect(await keyStore(inFile, none).where()).toBeNull();
    await keyStore(inFile, none).write(KEYS);
    expect(await keyStore(inFile, none).where()).toEqual({
      place: `in ${join(inFile, "wallet-keys.json")}, readable by this user alone`,
      inDataFolder: true,
    });

    const inKeychain = scratch();
    const entry = keychain();
    await keyStore(inKeychain, () => entry).write(KEYS);
    const where = await keyStore(inKeychain, none).where();
    expect(where).toEqual({
      place: `in the OS keychain, as "wallet-keys:${inKeychain}" under "auni"`,
      inDataFolder: false,
    });
    expect(JSON.stringify(where)).not.toContain(KEYS.evm);
  });

  it("removes the keys for good: the keychain's entry, then the file", async () => {
    const machine = keychainOfEntries();
    const dir = scratch();
    const store = keyStore(dir, machine);
    await store.write(KEYS);

    await store.remove();

    expect(machine(`wallet-keys:${dir}`).held).toBeNull();
    expect(await store.where()).toBeNull();
    expect(await store.read()).toBeNull();

    const inFile = keyStore(scratch(), none);
    await inFile.write(KEYS);
    await inFile.remove();
    expect(await inFile.read()).toBeNull();
  });

  // Removing the file first would leave an entry the next Auni in the folder takes up again.
  it("keeps everything when the keychain won't remove its entry", async () => {
    const entry = {
      ...keychain(),
      deletePassword: () => Promise.reject(new Error("The keychain is locked.")),
    };
    const dir = scratch();
    await keyStore(dir, () => entry).write(KEYS);

    await expect(keyStore(dir, () => entry).remove()).rejects.toThrow(/locked/u);
    expect(await keyStore(dir, () => entry).read()).toEqual(KEYS);
  });

  // An add cut off before its rename leaves the keys beside the file, too.
  it("removes the keys an add left half written", async () => {
    const dir = scratch();
    await keyStore(dir, none).write(KEYS);
    await writeFile(join(dir, "wallet-keys.json.new"), JSON.stringify(KEYS));

    await keyStore(dir, none).remove();

    await expect(stat(join(dir, "wallet-keys.json.new"))).rejects.toThrow(/ENOENT/u);
  });

  it("says stored keys are unreadable without quoting them", async () => {
    const dir = scratch();
    await writeFile(join(dir, "wallet-keys.json"), `{"evm": "${KEYS.evm.slice(0, 40)}`);
    const thrown = await keyStore(dir, none)
      .read()
      .catch((error: unknown) => error);
    expect(String(thrown)).toBe("Error: Auni's stored wallet keys are unreadable.");
  });
});

describe("machineKeyStore", () => {
  const saved = { HOME: process.env.HOME, AUNI_HOME: process.env.AUNI_HOME };
  afterEach(() => {
    Object.assign(process.env, saved);
    os.opened.length = 0;
    os.held.clear();
  });

  // A test's, a demo's or a throwaway's: a keychain entry would outlive its folder.
  it("keeps a second Auni's keys in its own folder, never reaching the keychain", async () => {
    process.env.AUNI_HOME = scratch();
    const store = machineKeyStore();
    expect(await store.read()).toBeNull();

    await store.write(KEYS);

    expect(await store.read()).toEqual(KEYS);
    expect(
      JSON.parse(await readFile(join(process.env.AUNI_HOME, "wallet-keys.json"), "utf8")),
    ).toEqual(KEYS);
    expect(os.opened).toEqual([]);
  });

  // Left to itself the library falls back to the kernel's keyring, which a reboot clears.
  it("keeps the owner's own keys, in ~/.auni, in the OS keychain: on Linux the Secret Service's alone", async () => {
    process.env.HOME = scratch();
    delete process.env.AUNI_HOME;
    const own = join(process.env.HOME, ".auni");

    await machineKeyStore().write(KEYS);

    expect(os.opened).toContainEqual([
      "auni",
      `wallet-keys:${own}`,
      { linux: { store: "secret-service" } },
    ]);
    expect(JSON.parse(os.held.get(`wallet-keys:${own}`)!)).toEqual(KEYS);
    expect(await readFile(join(own, "wallet-keys.json"), "utf8")).not.toContain(KEYS.evm);
  });
});

describe("generateKeys", () => {
  it("makes an EVM key and a Solana secret: its 32-byte seed, then the public key it makes", async () => {
    const keys = await generateKeys();
    const addresses = await addressesOf(keys);
    expect(addresses.evm).toBe(privateKeyToAddress(keys.evm as `0x${string}`));
    const secret = getBase58Encoder().encode(keys.solana!);
    expect(secret).toHaveLength(64);
    expect(getBase58Encoder().encode(addresses.solana!)).toEqual(secret.slice(32));
    expect(await generateKeys()).not.toEqual(keys);
  });
});
