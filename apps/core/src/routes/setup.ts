import type { SetupWire } from "@auni/shared";
import express, { Router } from "express";
import { sql } from "drizzle-orm";

import { db } from "../db/client.ts";
import { owner } from "../db/schema.ts";
import { brainsFact, keyWorthSaving, ownerState, spareKey, walletFacts } from "../setup.ts";
import { brainRowWire, LOGIN_SEEN_MS } from "./brains.ts";

/**
 * First run (`GET /setup` and its steps): where it stands, and the spare key the chats offer once
 * there is money worth keeping. First run ends with the owner's first chat, which makes the wallet
 * they didn't bring (routes/places.ts); one they already have comes in through the wallet's
 * private field before that. The X handle and watch-only wallets are Settings' (routes/me.ts).
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
