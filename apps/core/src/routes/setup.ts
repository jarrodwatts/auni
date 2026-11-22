import type { SetupWire } from "@auni/shared";
import express, { Router } from "express";
import { sql } from "drizzle-orm";

import { theOwner } from "../auth/owner.ts";
import { db } from "../db/client.ts";
import { owner } from "../db/schema.ts";
import { refreshStartingPoints } from "../jobs/kinds.ts";
import { WalletExists } from "../apps/contract.ts";
import { createWallet } from "../money/wallets.ts";
import { brainsFact, keyWorthSaving, ownerState, spareKey, walletFacts } from "../setup.ts";
import { brainRowWire, LOGIN_SEEN_MS } from "./brains.ts";

/**
 * First run, as the web app plays it: where it stands (setup.ts's facts, read fresh), and the two
 * steps only the owner takes. First run is their first take: sending it finishes first run, and
 * makes the wallet, unless they brought one (its private field). Their spare key comes later, once
 * the wallet holds money (setup.ts's keyWorthSaving): showing it is /me/keys, with its proof
 * (auth/proof.ts), then saying it's saved, or that they'll save it later.
 */
export const setupRouter = Router();
setupRouter.use(express.json({ limit: "1kb" }));

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

/** Finishing makes the wallet the owner didn't bring, then opens the app on their first take. */
setupRouter.post("/done", async (_req, res) => {
  if (!(await walletFacts()).addresses)
    await createWallet().catch((error: unknown) => {
      // Made meanwhile, say by a second tab finishing at once: that one is theirs.
      if (!(error instanceof WalletExists)) throw error;
    });
  await db.transaction(async (tx) => {
    const { startingPointsAt } = await theOwner(tx);
    await tx.update(owner).set({ welcomedAt: sql`coalesce(${owner.welcomedAt}, now())` });
    // So Auni's chat, which opens next, has its starting points ready.
    await refreshStartingPoints(tx, startingPointsAt);
  });
  res.json(await setupWire());
});
