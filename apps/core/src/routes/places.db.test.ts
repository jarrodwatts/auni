import { randomUUID } from "node:crypto";

import express from "express";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WalletAddresses } from "../apps/contract.ts";
import { db } from "../db/client.ts";
import { jobs, messages, owner, threads } from "../db/schema.ts";
import { walletAddresses } from "../money/wallets.ts";
import { prepareLeg } from "../money/actions.ts";
// After the wallet (above): these load the registry.
import { listThreads, threadMessages } from "../conversation/threads.ts";
import { turnKind } from "../jobs/kinds.ts";
import { setOwner, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import { stubRecipe } from "../test/recipe.ts";
import { serve } from "../test/serve.ts";
import { placesRouter } from "./places.ts";

// A wallet made only when asked, once, or not at all while `fails`. money/wallets.ts is imported
// above before anything loads the registry, so its own lookup of the wallet finds this one.
// While `held` is set, each make waits for it before looking, like a wallet service that hangs.
const wallet = vi.hoisted(() => ({
  made: null as WalletAddresses | null,
  fails: false,
  makes: 0,
  held: null as Promise<void> | null,
}));
vi.mock("../apps/registry.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../apps/registry.ts")>();
  const { WalletExists: Exists } = await import("../apps/contract.ts");
  const provided = {
    addresses: async () => wallet.made ?? { evm: null, solana: null },
    create: async () => {
      await wallet.held;
      if (wallet.fails) throw new Error("the wallet's service is down");
      if (wallet.made) throw new Exists();
      wallet.made = { evm: "0x00000000000000000000000000000000000000e1", solana: null };
      wallet.makes += 1;
      return wallet.made;
    },
  };
  return { ...real, theWallet: () => provided };
});

const NO_EFFECT = { gives: [], gets: [], grants: [] };

const url = serve(express().use("/places", placesRouter));

beforeEach(async () => {
  await wipe(jobs, messages, threads);
  await setOwner({ welcomedAt: null });
  wallet.made = null;
  wallet.fails = false;
  wallet.makes = 0;
  wallet.held = null;
});

afterEach(() => vi.restoreAllMocks());

/** A start as the web sends it; `ids` the same as a try before it for a retry. */
const startChat = (
  text = "AI power demand keeps climbing",
  ids = { id: randomUUID(), messageId: randomUUID() },
) =>
  fetch(url("/places/chat"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...ids, text }),
  });
const welcomedAt = async () => (await db.select().from(owner))[0]!.welcomedAt;

describe("the owner's first chat", () => {
  it("makes the wallet they didn't bring, and ends first run with it", async () => {
    expect((await startChat()).status).toBe(200);
    expect(await walletAddresses()).toMatchObject({
      evm: "0x00000000000000000000000000000000000000e1",
    });
    const first = await welcomedAt();
    expect(first).toBeInstanceOf(Date);
    // The new chat screen's starting points are on their way.
    expect(await queued("starting-points")).toMatchObject([{ key: "starting-points:none" }]);
    // A second chat keeps when first run ended, and asks for nothing again.
    expect((await startChat("Why did BTC fall?")).status).toBe(200);
    expect(await welcomedAt()).toEqual(first);
    expect(await queued("starting-points")).toHaveLength(1);
  });

  it("keeps the wallet they brought, making none", async () => {
    wallet.made = { evm: "0x00000000000000000000000000000000000000b1", solana: null };
    expect((await startChat()).status).toBe(200);
    expect(await walletAddresses()).toMatchObject({
      evm: "0x00000000000000000000000000000000000000b1",
    });
    expect(await welcomedAt()).toBeInstanceOf(Date);
  });

  // Review, 2026-11-25 (round 5): a wallet that couldn't be made started no chat, so a first
  // question that needed no wallet couldn't be asked. The wallet is made when a move needs it.
  it("starts the chat when the wallet can't be made yet, and the first move makes it", async () => {
    wallet.fails = true;
    const started = await startChat("Why did BTC fall?");
    expect(started.status).toBe(200);
    expect(
      await threadMessages(((await started.json()) as { thread: { id: string } }).thread.id),
    ).toMatchObject([{ role: "user", parts: [{ type: "text", text: "Why did BTC fall?" }] }]);
    expect(await welcomedAt()).toBeInstanceOf(Date);
    expect(await walletAddresses()).toEqual({ evm: null, solana: null });

    // A move while it still can't be made makes no card.
    const seen: (string | null)[] = [];
    const buy = stubRecipe({
      direction: undefined,
      describe: async () => {
        seen.push((await walletAddresses()).evm);
        return { summary: "Buy $10 of Nvidia", amountUsd: "10", effect: NO_EFFECT };
      },
    });
    await expect(prepareLeg(buy, {})).rejects.toThrow("wallet couldn't be made");
    expect(seen).toEqual([]);

    // Once it can be, the first move makes it, once, before its card reads where money is.
    wallet.fails = false;
    await prepareLeg(buy, {});
    await prepareLeg(buy, {});
    expect(seen).toEqual([
      "0x00000000000000000000000000000000000000e1",
      "0x00000000000000000000000000000000000000e1",
    ]);
    expect(wallet.makes).toBe(1);
  });

  // Review, 2026-11-25 (round 6): a wallet service that hung, rather than failed, held the first
  // take's request open with nothing saved, for as long as its client kept retrying.
  it("starts the chat when making the wallet hangs, and still makes only one", async () => {
    let release = () => {};
    wallet.held = new Promise((resolve) => (release = resolve));
    const started = await startChat("Why did BTC fall?");
    expect(started.status).toBe(200);
    const { thread } = (await started.json()) as { thread: { id: string } };
    expect(await threadMessages(thread.id)).toMatchObject([{ role: "user" }]);
    expect(await queued("turn")).toHaveLength(1);
    expect(await walletAddresses()).toEqual({ evm: null, solana: null });

    // The first move makes the wallet while the first take's try is still out; once that try
    // finishes too, there is still the one wallet.
    const buy = stubRecipe({
      direction: undefined,
      describe: async () => ({ summary: "Buy $10 of Nvidia", amountUsd: "10", effect: NO_EFFECT }),
    });
    const moved = prepareLeg(buy, {});
    release();
    await moved;
    await vi.waitFor(() => expect(wallet.makes).toBe(1));
    expect(await walletAddresses()).toMatchObject({
      evm: "0x00000000000000000000000000000000000000e1",
    });
  });

  it("makes no wallet once first run is over", async () => {
    await setOwner({ welcomedAt: new Date("2026-11-01T00:00:00Z") });
    wallet.fails = true;
    expect((await startChat()).status).toBe(200);
    expect(await walletAddresses()).toEqual({ evm: null, solana: null });
    expect(await welcomedAt()).toEqual(new Date("2026-11-01T00:00:00Z"));
  });
});

describe("a new chat", () => {
  // Review, 2026-11-25: the chat was made first and its message sent after, so a send that failed
  // left a chat with no words in it, which a reload hid ("This thread isn't here").
  it("is made with its first message in it and that message's turn queued", async () => {
    const ids = { id: randomUUID(), messageId: randomUUID() };
    const started = await startChat("Why did BTC fall?", ids);
    expect(started.status).toBe(200);
    expect(((await started.json()) as { thread: { id: string } }).thread.id).toBe(ids.id);
    // What a reload reads: the chat is listed, and its words are in it.
    expect((await listThreads()).map(({ id }) => id)).toEqual([ids.id]);
    expect(await threadMessages(ids.id)).toMatchObject([
      { id: ids.messageId, role: "user", parts: [{ type: "text", text: "Why did BTC fall?" }] },
    ]);
    expect(await queued("turn")).toMatchObject([
      { key: ids.messageId, data: { threadId: ids.id, messageId: ids.messageId } },
    ]);
  });

  it("is made once, with its message once, when its start is sent again", async () => {
    const ids = { id: randomUUID(), messageId: randomUUID() };
    expect((await startChat("Why did BTC fall?", ids)).status).toBe(200);
    expect((await startChat("Why did BTC fall?", ids)).status).toBe(200);
    expect(await db.select().from(threads)).toHaveLength(1);
    expect(await db.select().from(messages)).toHaveLength(1);
    expect(await queued("turn")).toHaveLength(1);
  });

  it("isn't there at all when its message couldn't be stored, and first run goes on", async () => {
    vi.spyOn(turnKind, "enqueue").mockRejectedValueOnce(new Error("the queue is down"));
    expect((await startChat()).status).toBe(500);
    expect(await db.select().from(threads)).toEqual([]);
    expect(await db.select().from(messages)).toEqual([]);
    expect(await welcomedAt()).toBeNull();
  });

  it("is never titled by a private key it starts with, which it keeps out", async () => {
    const key = generatePrivateKey();
    wallet.made = { evm: privateKeyToAddress(key), solana: null };
    const started = await startChat(`here's my key ${key}`);
    expect(await started.json()).toMatchObject({ thread: { title: "Auni" }, keyKeptOut: true });
    const stored = await db.select().from(messages);
    expect(stored).toMatchObject([{ role: "assistant" }]);
    expect(JSON.stringify(stored)).not.toContain(key.slice(2));
    expect(await queued("turn")).toEqual([]);
  });
});
