import type { SetupWire } from "@auni/shared";
import express, { Router } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { theOwner } from "../auth/owner.ts";
import { publishMe } from "../conversation/stream.ts";
import { db } from "../db/client.ts";
import { owner } from "../db/schema.ts";
import {
  enqueueSignalsRefresh,
  forceRefreshStartingPoints,
  refreshStartingPoints,
} from "../jobs/kinds.ts";
import { WalletExists } from "../apps/contract.ts";
import { createWallet } from "../money/wallets.ts";
import { brainsFact, keyWorthSaving, ownerState, spareKey, walletFacts } from "../setup.ts";
import { appendWatchedWallet, normalizeXHandle, resolveWatchedWallet } from "../signals.ts";
import { brainRowWire, LOGIN_SEEN_MS } from "./brains.ts";

/**
 * Local onboarding wizard & spare-key state (`GET /setup` and steps). Creating or importing a
 * wallet happens explicitly on Step 2 (or automatically if skipped on `/done`), and optional
 * personalization signals (X handle, watch-only wallet) kick off background signal synthesis and
 * tailored starting points immediately.
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

/** Explicitly generates a fresh local wallet during Step 2 of onboarding (idempotent). */
setupRouter.post("/wallet", async (_req, res) => {
  if (!(await walletFacts()).addresses) {
    await createWallet().catch((error: unknown) => {
      if (!(error instanceof WalletExists)) throw error;
    });
  }
  publishMe();
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

const doneBodySchema = z
  .object({
    xHandle: z.string().trim().max(120).optional(),
    watchedWallet: z.string().trim().max(160).optional(),
  })
  .optional();

/** Finishing validates any supplied signals first, ensures a wallet exists, and opens Auni's chat. */
setupRouter.post("/done", async (req, res) => {
  const parsed = doneBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }

  let xHandle: string | null = null;
  if (parsed.data?.xHandle) {
    xHandle = normalizeXHandle(parsed.data.xHandle);
    if (!xHandle) {
      res.status(400).json({
        error: "invalid_x_handle",
        detail: "Enter a valid X handle (letters, numbers, underscores), or leave it blank.",
      });
      return;
    }
  }

  let watchedResolved: Awaited<ReturnType<typeof resolveWatchedWallet>> | null = null;
  if (parsed.data?.watchedWallet) {
    try {
      watchedResolved = await resolveWatchedWallet(parsed.data.watchedWallet);
    } catch (error) {
      res.status(400).json({
        error: "invalid_wallet",
        detail:
          error instanceof Error
            ? error.message
            : "Enter a valid EVM 0x address, .eth ENS name, or Solana address.",
      });
      return;
    }
  }

  if (!(await walletFacts()).addresses)
    await createWallet().catch((error: unknown) => {
      // Made meanwhile, say by a second tab finishing at once: that one is theirs.
      if (!(error instanceof WalletExists)) throw error;
    });

  await db.transaction(async (tx) => {
    const me = await theOwner(tx);
    const nextWatched = watchedResolved
      ? appendWatchedWallet(me.watchedWallets, watchedResolved)
      : undefined;
    await tx.update(owner).set({
      welcomedAt: sql`coalesce(${owner.welcomedAt}, now())`,
      ...(xHandle ? { xHandle } : {}),
      ...(nextWatched ? { watchedWallets: nextWatched } : {}),
    });
    if (xHandle || watchedResolved) {
      await enqueueSignalsRefresh(tx, { replaceSummary: true });
      await forceRefreshStartingPoints(tx);
    } else {
      await refreshStartingPoints(tx, me.startingPointsAt);
    }
  });
  publishMe();
  res.json(await setupWire());
});
