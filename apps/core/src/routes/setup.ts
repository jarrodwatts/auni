import type { SetupWire } from "@auni/shared";
import express, { Router } from "express";
import { sql } from "drizzle-orm";

import { lockOwner } from "../auth/owner.ts";
import { publishMe } from "../conversation/stream.ts";
import { db } from "../db/client.ts";
import { owner } from "../db/schema.ts";
import { refreshStartingPoints } from "../jobs/kinds.ts";
import { WalletExists } from "../apps/contract.ts";
import { createWallet } from "../money/wallets.ts";
import { brainsFact, keyWorthSaving, ownerState, spareKey, walletFacts } from "../setup.ts";
import { brainRowWire, LOGIN_SEEN_MS } from "./brains.ts";

/**
 * First run (`GET /setup` and its steps): where it stands, finishing it as the first take is sent,
 * and the spare key the chats offer once there is money worth keeping. A wallet the owner already
 * has comes in through the wallet's private field before that first take; the X handle and
 * watch-only wallets are Settings' (routes/me.ts), never first run's.
 */
export const setupRouter = Router();
setupRouter.use(express.json({ limit: "4kb" }));

async function setupWire(): Promise<SetupWire> {
  const [brains, state, wallet, worthSaving] = await Promise.all([
    brainsFact({ notReadyFreshMs: LOGIN_SEEN_MS }),
    ownerState(),
    walletFacts(),
    keyWorthSaving(),
  ]);
  return {
    brains: { rows: brains.rows.map(brainRowWire), blocked: brains.blocked },
    wallet: { name: wallet.name, addresses: wallet.addresses, bring: wallet.bring },
    spareKey: spareKey(state, worthSaving && wallet.addresses !== null),
    welcomed: state.welcomedAt !== null,
  };
}

setupRouter.get("/", async (_req, res) => {
  res.json(await setupWire());
});

setupRouter.post("/backup", async (_req, res) => {
  if (!(await walletFacts()).addresses) return void res.status(409).json({ error: "no_wallet" });
  await db.update(owner).set({ backupSavedAt: sql`now()` });
  res.json(await setupWire());
});

/** Not now: the chats stop offering the spare key, which Settings' Wallet keys still shows. */
setupRouter.post("/backup/later", async (_req, res) => {
  await db.update(owner).set({ backupLaterAt: sql`coalesce(${owner.backupLaterAt}, now())` });
  res.json(await setupWire());
});

/**
 * The owner's first take is on its way: first run is done. Makes the wallet they didn't bring
 * (the first take is the first thing that can lead to a move), and starts their starting points.
 */
setupRouter.post("/done", async (_req, res) => {
  if (!(await walletFacts()).addresses)
    await createWallet().catch((error: unknown) => {
      // Made meanwhile, say by a second tab finishing at once: that one is theirs.
      if (!(error instanceof WalletExists)) throw error;
    });
  await db.transaction(async (tx) => {
    const me = await lockOwner(tx);
    await tx.update(owner).set({ welcomedAt: sql`coalesce(${owner.welcomedAt}, now())` });
    await refreshStartingPoints(tx, me.startingPointsAt);
  });
  publishMe();
  res.json(await setupWire());
});
