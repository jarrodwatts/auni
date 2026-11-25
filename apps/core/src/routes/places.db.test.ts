import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { WalletAddresses } from "../apps/contract.ts";
import { db } from "../db/client.ts";
import { jobs, owner, threads } from "../db/schema.ts";
import { walletAddresses } from "../money/wallets.ts";
import { setOwner, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import { serve } from "../test/serve.ts";
import { placesRouter } from "./places.ts";

// A wallet made only when asked, once, or not at all while `fails`. money/wallets.ts is imported
// above before anything loads the registry, so its own lookup of the wallet finds this one.
const wallet = vi.hoisted(() => ({ made: null as WalletAddresses | null, fails: false }));
vi.mock("../apps/registry.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../apps/registry.ts")>();
  const { WalletExists: Exists } = await import("../apps/contract.ts");
  const provided = {
    addresses: async () => wallet.made ?? { evm: null, solana: null },
    create: async () => {
      if (wallet.fails) throw new Error("the wallet's service is down");
      if (wallet.made) throw new Exists();
      wallet.made = { evm: "0x00000000000000000000000000000000000000e1", solana: null };
      return wallet.made;
    },
  };
  return { ...real, theWallet: () => provided };
});

const url = serve(express().use("/places", placesRouter));

beforeEach(async () => {
  await wipe(jobs, threads);
  await setOwner({ welcomedAt: null });
  wallet.made = null;
  wallet.fails = false;
});

const startChat = (text = "AI power demand keeps climbing") =>
  fetch(url("/places/chat"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
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

  // Review, 2026-11-25: first run ended as the wallet was made, before any chat, so a chat that
  // then failed left a reload on the ordinary new chat, with no way to bring a wallet.
  it("starts no chat when the wallet can't be made, and leaves them in first run", async () => {
    wallet.fails = true;
    const failed = await startChat();
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "wallet_not_made" });
    expect(await db.select().from(threads)).toEqual([]);
    expect(await welcomedAt()).toBeNull();
    expect(await queued("starting-points")).toEqual([]);
    // Sent again once it can be made, the take starts its chat.
    wallet.fails = false;
    expect((await startChat()).status).toBe(200);
    expect(await welcomedAt()).toBeInstanceOf(Date);
  });

  it("makes no wallet once first run is over", async () => {
    await setOwner({ welcomedAt: new Date("2026-11-01T00:00:00Z") });
    wallet.fails = true;
    expect((await startChat()).status).toBe(200);
    expect(await walletAddresses()).toEqual({ evm: null, solana: null });
    expect(await welcomedAt()).toEqual(new Date("2026-11-01T00:00:00Z"));
  });
});
