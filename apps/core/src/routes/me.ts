import {
  addWatchedWalletRequestSchema,
  type meSchema,
  SOLANA_BRING_FIELD,
  updateMeRequestSchema,
} from "@auni/shared";
import express, { Router } from "express";
import { z } from "zod";

import { brainStatus, preferredBrainId } from "../agent/brain.ts";
import { reachWire } from "../always-on.ts";
import { lockOwner, theOwner } from "../auth/owner.ts";
import { ownerHere } from "../auth/proof.ts";
import { canBeHome, channelStates, pairedChannels } from "../channels/home.ts";
import { publishMe } from "../conversation/stream.ts";
import { db } from "../db/client.ts";
import { aMoveLanded, answerStarPrompt, starOnGitHub, starredOnGitHub } from "../github-star.ts";
import { NoWallet, WalletExists } from "../apps/contract.ts";
import { owner } from "../db/schema.ts";
import { enqueueSignalsRefresh, forceRefreshStartingPoints } from "../jobs/kinds.ts";
import { postgresKnowsZone } from "../money/value-history.ts";
import {
  addMissingKey,
  missingAddress,
  noSolanaBring,
  revealWalletKeys,
  walletAddresses,
} from "../money/wallets.ts";
import {
  appendWatchedWallet,
  normalizeXHandle,
  refreshOwnerSignals,
  resolveWatchedWallet,
} from "../signals.ts";

export const meRouter = Router();

/**
 * The owner as web reads them: their settings, personalization signals, wallet addresses,
 * what Auni thinks with, the chat apps it talks in, how the owner reaches it, and star status.
 */
async function meWire(proved = false): Promise<z.input<typeof meSchema>> {
  const [me, wallets, walletLacks, bringSolana, brain, channels, reach, landed] = await Promise.all(
    [
      theOwner(),
      walletAddresses().catch((error: unknown) => {
        console.error("reading the wallet's addresses failed", error);
        return { evm: null, solana: null };
      }),
      missingAddress().catch(() => null),
      noSolanaBring().then(
        (no) => (no === null ? SOLANA_BRING_FIELD : null),
        () => null,
      ),
      brainStatus(),
      channelStates(),
      reachWire(),
      aMoveLanded(),
    ],
  );
  return {
    name: me.name,
    timeZone: me.timeZone,
    look: me.look,
    brief: me.brief,
    preferredBrain: preferredBrainId(),
    xHandle: me.xHandle,
    watchedWallets: me.watchedWallets,
    profileSummary: me.profileSummary,
    profileSignals: me.profileSignals,
    ownerHere: proved,
    wallets,
    walletLacks,
    bringSolana,
    brain: brain.ready
      ? {
          ready: true,
          name: brain.name,
          login: brain.login,
          ...(brain.restingUntil ? { restingUntil: brain.restingUntil.toISOString() } : {}),
        }
      : { ready: false, fixes: [...brain.fixes] },
    channels,
    home: me.homeChannel,
    welcomed: me.welcomedAt !== null,
    reach,
    starPrompt: me.starPromptAnsweredAt !== null ? "answered" : landed ? "ask" : "waiting",
  };
}

// Each router parses the bodies it takes, at its own size limit.
meRouter.use(express.json({ limit: "16kb" }));

meRouter.get("/", async (req, res) => {
  res.json(await meWire(ownerHere(req)));
});

meRouter.patch("/", async (req, res) => {
  const parsed = updateMeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
    return;
  }

  const patch = parsed.data;
  if (patch.time_zone !== undefined && !(await postgresKnowsZone(patch.time_zone))) {
    res.status(400).json({ error: "unknown_time_zone" });
    return;
  }
  if (patch.home_channel !== undefined && !canBeHome(patch.home_channel, await pairedChannels())) {
    res.status(400).json({ error: "channel_not_paired" });
    return;
  }
  let xHandle: string | null | undefined;
  if (patch.x_handle !== undefined) {
    if (patch.x_handle === null || patch.x_handle.trim() === "") {
      xHandle = null;
    } else {
      const normalized = normalizeXHandle(patch.x_handle);
      if (!normalized) {
        res.status(400).json({
          error: "invalid_x_handle",
          detail: "Enter a valid X handle (letters, numbers, underscores).",
        });
        return;
      }
      xHandle = normalized;
    }
  }
  if (Object.keys(patch).length > 0) {
    await db.transaction(async (tx) => {
      await tx.update(owner).set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.time_zone !== undefined ? { timeZone: patch.time_zone } : {}),
        ...(patch.home_channel !== undefined ? { homeChannel: patch.home_channel } : {}),
        ...(patch.look !== undefined ? { look: patch.look } : {}),
        ...(patch.brief !== undefined ? { brief: patch.brief } : {}),
        ...(xHandle !== undefined ? { xHandle } : {}),
        ...(patch.profile_summary !== undefined
          ? { profileSummary: patch.profile_summary || null }
          : {}),
      });
      if (xHandle !== undefined) {
        await enqueueSignalsRefresh(tx, { replaceSummary: true });
      } else if (patch.profile_summary !== undefined) {
        await forceRefreshStartingPoints(tx);
      }
    });
    publishMe();
  }
  res.json(await meWire(ownerHere(req)));
});

/** Adds a watch-only public wallet (EVM, ENS, or Solana) for tailored prompts and context. */
meRouter.post("/watched-wallets", async (req, res) => {
  const parsed = addWatchedWalletRequestSchema.safeParse(req.body);
  if (!parsed.success)
    return void res.status(400).json({ error: "invalid_body", issues: parsed.error.issues });
  try {
    const resolved = await resolveWatchedWallet(parsed.data.address, parsed.data.label);
    await db.transaction(async (tx) => {
      const me = await lockOwner(tx);
      const next = appendWatchedWallet(me.watchedWallets, resolved);
      await tx.update(owner).set({ watchedWallets: next });
      await enqueueSignalsRefresh(tx, { replaceSummary: !me.profileSummary });
    });
    publishMe();
    res.json(await meWire(ownerHere(req)));
  } catch (error) {
    res.status(400).json({
      error: "invalid_wallet",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

/** Removes a watch-only wallet by address. */
meRouter.delete("/watched-wallets/:address", async (req, res) => {
  const target = req.params.address.toLowerCase();
  await db.transaction(async (tx) => {
    const me = await lockOwner(tx);
    const next = me.watchedWallets.filter((w) => w.address.toLowerCase() !== target);
    await tx.update(owner).set({ watchedWallets: next });
    await enqueueSignalsRefresh(tx);
  });
  publishMe();
  res.json(await meWire(ownerHere(req)));
});

/** Refreshes X + watch-only wallet signals and re-synthesizes the owner profile + starting points. */
meRouter.post("/signals/refresh", async (req, res) => {
  await refreshOwnerSignals({ replaceSummary: true }).catch(() => null);
  res.json(await meWire(ownerHere(req)));
});

/**
 * The wallet's keys, for a request that proves the owner is there (auth/proof.ts), as first run's
 * is. So whoever is at a browser paired long ago can't read the keys off Auni's button alone.
 * Never cached anywhere on the way.
 */
meRouter.post("/keys", async (req, res) => {
  if (!ownerHere(req)) return void res.status(403).json({ error: "pair_again" });
  res.setHeader("Cache-Control", "no-store");
  const keys = await revealWalletKeys().catch((error: unknown) => {
    if (error instanceof NoWallet) return null;
    throw error;
  });
  if (!keys) return void res.status(409).json({ error: "no_wallet" });
  res.json({ keys });
});

/**
 * Makes the key a wallet brought with one alone lacks, beside it: a new Solana address beside an
 * EVM key, or the other way round. It changes no key the wallet holds and shows none, so it takes
 * the owner's session alone; the owner saves the new key with their backup from Show wallet keys,
 * which takes their proof.
 */
meRouter.post("/wallet/missing", async (req, res) => {
  try {
    await addMissingKey();
  } catch (error) {
    if (error instanceof WalletExists || error instanceof NoWallet)
      return void res.status(409).json({ error: "nothing_missing" });
    throw error;
  }
  publishMe();
  res.json(await meWire(ownerHere(req)));
});

/**
 * The ask for a star on GitHub (github-star.ts). Check runs before the web asks: already
 * starred is an answer, and a check gh couldn't make (null) is none. Star stars it in place, an
 * answer once it did; when it couldn't, the web opens GitHub and the owner's close answers.
 */
meRouter.post("/star/check", async (_req, res) => {
  const starred = await starredOnGitHub();
  if (starred) await answerStarPrompt();
  res.json({ starred });
});

meRouter.post("/star", async (_req, res) => {
  const starred = await starOnGitHub();
  if (starred) await answerStarPrompt();
  res.json({ starred });
});

meRouter.post("/star/answer", async (_req, res) => {
  await answerStarPrompt();
  res.json({ answered: true });
});
