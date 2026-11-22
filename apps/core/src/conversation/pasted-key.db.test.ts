import { createKeyPairFromPrivateKeyBytes, getBase58Decoder } from "@solana/kit";
import { eq } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, jobs, messages, threads } from "../db/schema.ts";
import type { PrivateField } from "../private-fields.ts";
import { insertThread, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import { pastedKey } from "./pasted-key.ts";
import { sendMessage } from "./send.ts";

// A private key pasted into a message is caught before the message is stored or read by the
// agent, and only what is surely a key: nothing else is ever held back.

const wallet = vi.hoisted(() => ({
  evm: null as string | null,
  /** Why the wallet takes no Solana key now, or null while it does. */
  noBring: null as string | null,
}));
vi.mock("../money/wallets.ts", async (original) => ({
  ...(await original()),
  walletAddresses: async () => ({ evm: wallet.evm, solana: null }),
  noSolanaBring: async () => wallet.noBring,
  walletFields: async () => (wallet.noBring ? [] : [solanaField]),
}));
const solanaField = {
  id: "wallet-solana",
  label: "Solana private key",
  goes: "It goes straight to Auni's wallet on this computer.",
  app: "local-key",
  inputs: [{ name: "solana", label: "Solana private key", placeholder: "", set: false }],
  link: null,
  confirms: true,
  proof: true,
  check: async () => ({ preview: "", notes: [] }),
  accept: async () => null,
} satisfies PrivateField;

/** A Solana secret as wallets export it: its 32-byte seed, then the public key it makes, in base58. */
async function solanaSecret(): Promise<string> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const pair = await createKeyPairFromPrivateKeyBytes(seed, true);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return getBase58Decoder().decode(new Uint8Array([...seed, ...publicKey]));
}
/** A Solana transaction's signature: 64 bytes, in base58, whose halves are no key pair. */
const signature = () => getBase58Decoder().decode(crypto.getRandomValues(new Uint8Array(64)));
/** An EVM transaction hash: 64 hex characters, as a key is. */
const txHash = () => generatePrivateKey();

const nothingHeld = async () => false;

beforeEach(async () => {
  Object.assign(wallet, { evm: null, noBring: null });
  await wipe(threads, messages, actions, jobs);
});
afterEach(() => vi.restoreAllMocks());

describe("pastedKey", () => {
  it("catches a real Solana key, however it is said", async () => {
    const key = await solanaSecret();
    expect(await pastedKey(key, nothingHeld)).toEqual({ kind: "solana" });
    expect(await pastedKey(`here's my key: ${key}. thanks`, nothingHeld)).toEqual({
      kind: "solana",
    });
  });

  it("leaves a transaction's signature, a Solana address and a hash alone", async () => {
    const holds = vi.fn(nothingHeld);
    const address = (await solanaSecret()).slice(0, 44);
    for (const text of [
      `did ${signature()} land?`,
      `send it to ${address}`,
      `what's ${txHash()}?`,
      `${txHash()} and ${txHash().slice(2)}`,
    ])
      expect(await pastedKey(text, holds), text).toBeNull();
    // A hash is looked up, as a key holding money would be, and found to hold nothing.
    expect(holds).toHaveBeenCalled();
  });

  it("catches an EVM key that is the wallet's own, or one holding money, and only those", async () => {
    const own = generatePrivateKey();
    wallet.evm = privateKeyToAddress(own);
    const holds = vi.fn(nothingHeld);
    expect(await pastedKey(own, holds)).toEqual({ kind: "evm", own: true });
    expect(await pastedKey(own.slice(2), holds)).toEqual({ kind: "evm", own: true });
    const funded = generatePrivateKey();
    expect(
      await pastedKey(funded, async (address) => address === privateKeyToAddress(funded)),
    ).toEqual({ kind: "evm", own: false });
    // Hex inside a longer run (calldata, say) is no key.
    expect(await pastedKey(`0x${own.slice(2)}00`, holds)).toBeNull();
  });
});

describe("a message holding a key", () => {
  const inThread = async () => (await insertThread())!;

  it("is never stored or answered by the agent, and Auni offers the key's private field", async () => {
    const thread = await inThread();
    const key = await solanaSecret();
    const id = crypto.randomUUID();
    expect(await sendMessage(thread, { id, text: `my sol key ${key}` })).toBe("key_kept_out");
    const rows = await db.select().from(messages).where(eq(messages.threadId, thread.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, role: "assistant", origin: "automation" });
    expect(await queued("turn")).toEqual([]);
    const [card] = await db.select().from(actions);
    expect(card).toMatchObject({
      tool: "request_secret",
      status: "awaiting_permission",
      input: { field: "wallet-solana", app: "local-key" },
      summary: "Solana private key",
    });
    const kept = JSON.stringify([rows, card, await queued()]);
    expect(kept).not.toContain(key);
    expect(kept).toContain("paste it into this card instead");
    // A send tried again answers once.
    expect(await sendMessage(thread, { id, text: `my sol key ${key}` })).toBe("key_kept_out");
    expect(await db.select().from(messages)).toHaveLength(1);
    expect(await db.select().from(actions)).toHaveLength(1);
  });

  it("from a chat app, says it passed through that app, and goes back there", async () => {
    const thread = await inThread();
    const key = await solanaSecret();
    const id = crypto.randomUUID();
    await sendMessage(thread, { id, text: key, channel: "telegram" });
    const [row] = await db.select().from(messages);
    expect(JSON.stringify(row!.parts)).toContain("It has already passed through Telegram");
    expect(await queued("deliver")).toMatchObject([
      { data: { channel: "telegram", threadId: thread.id, messageId: id } },
    ]);
  });

  it("says why when the wallet can't take it, and makes no card", async () => {
    wallet.noBring = "Privy makes its own keys, so it can't take a Solana key you already hold.";
    const thread = await inThread();
    await sendMessage(thread, { id: crypto.randomUUID(), text: await solanaSecret() });
    const [row] = await db.select().from(messages);
    expect(JSON.stringify(row!.parts)).toContain("Privy makes its own keys");
    expect(await db.select().from(actions)).toEqual([]);
  });

  it("leaves every other message as it was", async () => {
    const thread = await inThread();
    const id = crypto.randomUUID();
    expect(await sendMessage(thread, { id, text: `did ${signature()} land?` })).toBe("sent");
    expect(await db.select().from(messages)).toMatchObject([{ id, role: "user" }]);
    expect(await queued("turn")).toHaveLength(1);
  });
});
