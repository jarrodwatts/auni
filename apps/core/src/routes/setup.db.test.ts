import { eq } from "drizzle-orm";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireOwner } from "../auth/middleware.ts";
import { db } from "../db/client.ts";
import { actions, arrivals, fills, jobs, owner, ownerSessions } from "../db/schema.ts";
import { env } from "../env.ts";
import type { WalletAddresses } from "../apps/contract.ts";
import { insertAction, setOwner, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import { serve } from "../test/serve.ts";
import { ownerRouter } from "./owner.ts";
import { setupRouter } from "./setup.ts";

// A wallet made only when asked, once.
const wallet = vi.hoisted(() => ({ made: null as WalletAddresses | null }));
vi.mock("../apps/registry.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../apps/registry.ts")>();
  const { WalletExists: Exists } = await import("../apps/contract.ts");
  const provided = {
    addresses: async () => wallet.made ?? { evm: null, solana: null },
    create: async () => {
      if (wallet.made) throw new Exists();
      wallet.made = { evm: "0x00000000000000000000000000000000000000e1", solana: null };
      return wallet.made;
    },
  };
  return {
    ...real,
    theWallet: () => provided,
    walletApp: () => ({ about: { id: "stand-in", name: "Stand-in" }, provided }),
  };
});
vi.mock("../agent/brain.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  brainRows: async () => [
    {
      id: "claude-code",
      name: "Claude Code",
      state: "resting",
      login: "your Claude Max plan",
      models: [],
      until: new Date("2026-11-08T15:40:00Z"),
    },
  ],
}));

const url = serve(express().use("/owner", ownerRouter).use("/setup", requireOwner, setupRouter));

let cookie = "";
beforeEach(async () => {
  await wipe(ownerSessions, jobs, fills, actions);
  await setOwner({ welcomedAt: null, backupSavedAt: null, backupLaterAt: null });
  wallet.made = null;
  const { mintPairingCode } = await import("../auth/owner.ts");
  const paired = await fetch(url("/owner/pair"), {
    method: "POST",
    headers: { origin: env.WEB_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ code: await mintPairingCode() }),
  });
  cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
});

const read = () => fetch(url("/setup"), { headers: { cookie } });
const post = (path: string, body: unknown = {}, origin = env.WEB_ORIGIN) =>
  fetch(url(`/setup/${path}`), {
    method: "POST",
    headers: { cookie, origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("GET /setup", () => {
  it("answers only the owner's browser", async () => {
    expect((await fetch(url("/setup"))).status).toBe(401);
  });

  it("says where first run stands, read fresh, for this browser", async () => {
    expect(await (await read()).json()).toEqual({
      brains: {
        rows: [
          {
            id: "claude-code",
            name: "Claude Code",
            state: "resting",
            login: "your Claude Max plan",
            models: [],
            until: "2026-11-08T15:40:00.000Z",
          },
        ],
        blocked: null,
      },
      wallet: { name: "Stand-in", addresses: null, bring: null },
      spareKey: "not-yet",
      welcomed: false,
    });
  });
});

describe("finishing first run", () => {
  it("takes the first take only from the app's own pages", async () => {
    expect((await post("done", {}, "https://evil.example")).status).toBe(403);
    expect(wallet.made).toBeNull();
  });

  it("keeps the spare key saved only once there is a wallet to back up", async () => {
    expect(await (await post("backup")).json()).toEqual({ error: "no_wallet" });
    await post("done");
    expect(await (await post("backup")).json()).toMatchObject({ spareKey: "saved" });
  });

  it("offers the spare key once a first trade has gone through, until put off for later", async () => {
    await post("done");
    expect(await (await read()).json()).toMatchObject({ spareKey: "not-yet" });
    const bought = await insertAction({});
    await db.insert(fills).values({
      actionId: bought.id,
      instrument: "0xLLY",
      chain: "monad",
      side: "buy",
      quantity: "0.04",
      usdValue: "30.00",
    });
    expect(await (await read()).json()).toMatchObject({ spareKey: "due" });
    // Later holds for every chat and tab, read again from core.
    expect(await (await post("backup/later")).json()).toMatchObject({ spareKey: "later" });
    expect(await (await read()).json()).toMatchObject({ spareKey: "later" });
  });

  // Review, 2026-11-17: money added for a card the owner then declined held no fill, so its
  // wallet's key was never offered, and lived only on this machine.
  it("offers the spare key once money came in and nothing waits on the owner, traded or not", async () => {
    await post("done");
    const waiting = await insertAction({ status: "awaiting_permission" });
    await db.insert(arrivals).values({
      chain: "monad",
      txHash: "0xdeposit",
      position: "log:0",
      instrument: "0xUSDC",
      baseUnits: "50000000",
      decimals: 6,
      usdValue: "50.00",
      kind: "deposit",
      at: new Date(),
      block: 1,
    });
    // It landed for the card still waiting: the owner is busy with what it's for.
    expect(await (await read()).json()).toMatchObject({ spareKey: "not-yet" });
    await db.update(actions).set({ status: "cancelled" }).where(eq(actions.id, waiting.id));
    expect(await (await read()).json()).toMatchObject({ spareKey: "due" });
  });

  it("makes the wallet the owner didn't bring, and opens the app on their take", async () => {
    const done = await post("done");
    expect(await done.json()).toMatchObject({
      welcomed: true,
      wallet: { addresses: { evm: "0x00000000000000000000000000000000000000e1" } },
      // Nothing is asked first: the spare key waits for a first trade to go through.
      spareKey: "not-yet",
    });
    const finishedAt = async () => (await db.select().from(owner))[0]!.welcomedAt;
    const first = await finishedAt();
    expect(first).toBeInstanceOf(Date);
    // Auni's chat opens next, with its starting points on their way.
    expect(await queued("starting-points")).toMatchObject([{ key: "starting-points:none" }]);
    // Finishing again keeps when it first finished.
    await post("done");
    expect(await finishedAt()).toEqual(first);
    expect(await queued("starting-points")).toHaveLength(1);
  });

  it("keeps the wallet the owner brought, making none", async () => {
    wallet.made = { evm: "0x00000000000000000000000000000000000000b1", solana: null };
    expect(await (await post("done")).json()).toMatchObject({
      welcomed: true,
      wallet: { addresses: { evm: "0x00000000000000000000000000000000000000b1" } },
    });
  });

  it("rejects invalid X handle or watched wallet before marking onboarding done", async () => {
    const badX = await post("done", { xHandle: "invalid handle with spaces!!" });
    expect(badX.status).toBe(400);
    expect(await badX.json()).toMatchObject({ error: "invalid_x_handle" });
    expect((await db.select().from(owner))[0]!.welcomedAt).toBeNull();

    const badWallet = await post("done", { watchedWallet: "not-a-valid-address" });
    expect(badWallet.status).toBe(400);
    expect(await badWallet.json()).toMatchObject({ error: "invalid_wallet" });
    expect((await db.select().from(owner))[0]!.welcomedAt).toBeNull();
  });
});
