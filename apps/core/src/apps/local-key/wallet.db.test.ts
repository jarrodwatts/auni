import { getBase58Decoder } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { tempDir } from "../../test/temp-dir.ts";
import { actions } from "../../db/schema.ts";
import { signedTxs } from "./tables.ts";
import { walletDocument } from "../../money/typed-data.ts";
import { PrivateFieldRefused } from "../../private-fields.ts";
import { wipe } from "../../test/db.ts";
import { NoWallet, WalletExists } from "../contract.ts";
import { DELEGATION_MANAGER } from "./evm.ts";
import { addressesOf, generateKeys, keyStore, type KeyStore } from "./keys.ts";
import { localKeyWalletIn } from "./wallet.ts";

// No chain answers what an account's code is: no delegation anywhere.
vi.mock("../../money/chains.ts", async (original) => ({
  ...(await original()),
  evmClient: () => ({ getCode: async () => undefined }),
}));

const noKeychain = () => {
  throw new Error("No Secret Service on this machine.");
};

// web3's documented account.
const EVM_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const EVM_ADDRESS = "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23";

beforeEach(() => wipe(actions, signedTxs));

const folder = () => tempDir("auni-");
const wallet = () => localKeyWalletIn(keyStore(folder(), noKeychain));
const made = async () => {
  const theirs = wallet();
  await theirs.create();
  return theirs;
};
const signer = async () =>
  (await made()).signer({ actionId: "a", attempt: 1, onSent: async () => {} });

describe("localKeyWallet", () => {
  it("makes nothing until the owner chooses: no addresses, keys or signer", async () => {
    const theirs = wallet();
    expect(await theirs.addresses()).toEqual({ evm: null, solana: null });
    expect(await theirs.addresses()).toEqual({ evm: null, solana: null });
    await expect(theirs.revealKeys()).rejects.toBeInstanceOf(NoWallet);
    await expect(
      theirs.signer({ actionId: "a", attempt: 1, onSent: async () => {} }),
    ).rejects.toBeInstanceOf(NoWallet);
  });

  it("makes its keys when asked, once, and answers with the same addresses after", async () => {
    const theirs = wallet();
    const addresses = await theirs.create();
    expect(addresses.evm).toMatch(/^0x[0-9a-fA-F]{40}$/u);
    expect(addresses.solana).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u);
    expect(await theirs.addresses()).toEqual(addresses);
    await expect(theirs.create()).rejects.toBeInstanceOf(WalletExists);
    const signing = await theirs.signer({ actionId: "a", attempt: 1, onSent: async () => {} });
    expect({ evm: signing.evmAddress, solana: signing.solanaAddress }).toEqual(addresses);
  });

  // Two processes on one database (or two taps at once) must never make two wallets.
  it("makes one wallet however many ask at once", async () => {
    const dir = folder();
    const processes = Array.from({ length: 4 }, () => localKeyWalletIn(keyStore(dir, noKeychain)));
    const tried = await Promise.allSettled(processes.map((each) => each.create()));
    const won = tried.filter((each) => each.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const lost of tried.filter((each) => each.status === "rejected"))
      expect(lost.reason).toBeInstanceOf(WalletExists);
    for (const each of processes) expect(await each.addresses()).toEqual(won[0]!.value);
  });

  it("holds the keys it made, never reading the store again", async () => {
    const store = keyStore(folder(), noKeychain);
    let reads = 0;
    let locked = false;
    const counted: KeyStore = {
      ...store,
      read: () => {
        reads += 1;
        if (locked) throw new Error("The keychain can't be read now.");
        return store.read();
      },
    };
    const theirs = localKeyWalletIn(counted);
    const addresses = await theirs.create();
    const before = reads;
    // As the keychain locking while Auni runs.
    locked = true;
    for (let tick = 0; tick < 5; tick++) expect(await theirs.addresses()).toEqual(addresses);
    expect(reads).toBe(before);
    // Another process finds them in the store once, then holds them too.
    locked = false;
    const other = localKeyWalletIn(counted);
    expect(await other.addresses()).toEqual(addresses);
    const found = reads;
    await other.addresses();
    expect(reads).toBe(found);
  });

  it("says where its keys are, and once they're removed holds no wallet", async () => {
    const theirs = await made();
    expect(await theirs.keptHere!.where()).toMatchObject({ inDataFolder: true });

    await theirs.keptHere!.remove();

    expect(await theirs.keptHere!.where()).toBeNull();
    expect(await theirs.addresses()).toEqual({ evm: null, solana: null });
  });

  it("has no sponsor, so it pays its own gas everywhere", async () => {
    expect(wallet().sponsored).toBeUndefined();
  });

  it("knows nothing of a send it never journalled, such as another wallet's", async () => {
    const theirs = wallet();
    expect(await theirs.sendStatus("privy-transaction-id")).toBe("pending");
    expect(await theirs.sendStatus("7a1f7a5e-0c4b-4b0e-9a55-3d2f0c1b9e10")).toBe("pending");
  });

  it("reveals the keys it signs with", async () => {
    const keys = await (await made()).revealKeys();
    expect(keys.evm).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(keys.solana).toEqual(expect.any(String));
  });

  // Under EIP-7702 the account runs the DeleGator, which takes the key's signature on these
  // as leave to do anything, so no venue's document may be one of them.
  it("won't sign typed data the wallet's own code or its delegation manager would act on", async () => {
    const signing = await signer();
    const document = (verifyingContract: string) =>
      walletDocument({
        domain: { name: "Anything", version: "1", chainId: 143, verifyingContract },
        types: { Note: [{ name: "text", type: "string" }] },
        primaryType: "Note",
        message: { text: "hi" },
      });
    for (const verifier of [signing.evmAddress, DELEGATION_MANAGER.toLowerCase()])
      await expect(signing.signEvmTypedData(document(verifier))).rejects.toThrow(
        "Auni won't sign this",
      );
    await expect(
      signing.signEvmTypedData(document("0x2222222222222222222222222222222222222222")),
    ).resolves.toMatch(/^0x/u);
  });
});

describe("bringing keys the owner holds", () => {
  it("shows the addresses they sign for, then takes them in and signs with them", async () => {
    const theirs = wallet();
    const field = theirs.bring!;
    expect(field.inputs.map(({ name }) => name)).toEqual(["keys", "solana"]);
    const checked = await field.check({ keys: EVM_KEY, solana: "" });
    expect(checked.preview).toBe(EVM_ADDRESS);
    expect(checked.notes.join(" ")).not.toContain(EVM_KEY.slice(2));
    // Checking takes nothing in.
    expect(await theirs.addresses()).toEqual({ evm: null, solana: null });
    await field.accept({ keys: EVM_KEY, solana: "" });
    expect(await theirs.addresses()).toEqual({ evm: EVM_ADDRESS, solana: null });
    expect(await theirs.revealKeys()).toEqual({ evm: EVM_KEY, solana: null });
  });

  it("refuses over a wallet Auni holds already, and changes nothing", async () => {
    const theirs = await made();
    const before = await theirs.revealKeys();
    await expect(field(theirs).check({ keys: EVM_KEY })).rejects.toBeInstanceOf(
      PrivateFieldRefused,
    );
    await expect(field(theirs).accept({ keys: EVM_KEY })).rejects.toBeInstanceOf(
      PrivateFieldRefused,
    );
    expect(await theirs.revealKeys()).toEqual(before);
  });

  // Brought with its EVM key alone, it had no Solana address and no way to gain one.
  it("makes the Solana key an EVM key brought alone lacks, keeping the EVM key", async () => {
    const theirs = wallet();
    await field(theirs).accept({ keys: EVM_KEY, solana: "" });
    const added = await theirs.addMissing!();
    expect(added.evm).toBe(EVM_ADDRESS);
    expect(added.solana).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u);
    expect(await theirs.addresses()).toEqual(added);
    const keys = await theirs.revealKeys();
    expect(keys.evm).toBe(EVM_KEY);
    const signs = await theirs.signer({ actionId: "a", attempt: 1, onSent: async () => {} });
    expect(signs.solanaAddress).toBe(added.solana);
    // It holds both now, so there is nothing to add; with no wallet there is nothing to add to.
    await expect(theirs.addMissing!()).rejects.toBeInstanceOf(WalletExists);
    expect(await theirs.revealKeys()).toEqual(keys);
    await expect(wallet().addMissing!()).rejects.toBeInstanceOf(NoWallet);
  });

  it("refuses keys that aren't keys before touching the store", async () => {
    const theirs = wallet();
    await expect(field(theirs).accept({ keys: "0x1234" })).rejects.toBeInstanceOf(
      PrivateFieldRefused,
    );
    expect(await theirs.addresses()).toEqual({ evm: null, solana: null });
  });
});

describe("bringing a Solana key beside an EVM key brought alone", () => {
  const evmAlone = async () => {
    const theirs = wallet();
    await field(theirs).accept({ keys: EVM_KEY, solana: "" });
    return theirs;
  };

  it("shows the address it signs for, then adds it, keeping the EVM key", async () => {
    const theirs = await evmAlone();
    const { solana } = await generateKeys();
    const address = await addressesOf({ evm: null, solana });
    const checked = await theirs.bringSolana!.check({ solana: solana! });
    expect(checked.preview).toBe(`${address.solana} on Solana`);
    expect(checked.notes.join(" ")).not.toContain(solana!.slice(0, 20));
    // Checking takes nothing in.
    expect(await theirs.addresses()).toEqual({ evm: EVM_ADDRESS, solana: null });
    await theirs.bringSolana!.accept({ solana: solana! });
    // Held at once, as a key made beside it is: no restart, no second read of the store.
    expect(await theirs.addresses()).toEqual({ evm: EVM_ADDRESS, solana: address.solana });
    expect(await theirs.revealKeys()).toEqual({ evm: EVM_KEY, solana });
    const signs = await theirs.signer({ actionId: "a", attempt: 1, onSent: async () => {} });
    expect(signs.solanaAddress).toBe(address.solana);
  });

  it("only ever adds: a second key, a wallet that holds both, and no wallet are refused", async () => {
    const theirs = await evmAlone();
    const [first, second] = [(await generateKeys()).solana!, (await generateKeys()).solana!];
    await theirs.bringSolana!.accept({ solana: first });
    const kept = await theirs.revealKeys();
    for (const step of ["check", "accept"] as const)
      await expect(theirs.bringSolana![step]({ solana: second })).rejects.toBeInstanceOf(
        PrivateFieldRefused,
      );
    expect(await theirs.revealKeys()).toEqual(kept);
    await expect((await made()).bringSolana!.accept({ solana: second })).rejects.toBeInstanceOf(
      PrivateFieldRefused,
    );
    await expect(wallet().bringSolana!.accept({ solana: second })).rejects.toBeInstanceOf(
      PrivateFieldRefused,
    );
  });

  // A transaction's signature is 64 bytes of base58 too, but its halves aren't a key pair.
  it("refuses what isn't a Solana key, before touching the store", async () => {
    const theirs = await evmAlone();
    const signature = getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)));
    await expect(theirs.bringSolana!.accept({ solana: signature })).rejects.toBeInstanceOf(
      PrivateFieldRefused,
    );
    expect(await theirs.addresses()).toEqual({ evm: EVM_ADDRESS, solana: null });
  });
});

const field = (theirs: Awaited<ReturnType<typeof wallet>>) => theirs.bring!;
