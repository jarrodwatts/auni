import { type meSchema, SOLANA_BRING_FIELD, updateMeRequestSchema } from "@auni/shared";
import express, { Router } from "express";
import { z } from "zod";

import { brainStatus } from "../agent/brain.ts";
import { reachWire } from "../always-on.ts";
import { theOwner } from "../auth/owner.ts";
import { ownerHere } from "../auth/proof.ts";
import { canBeHome, channelStates, pairedChannels } from "../channels/home.ts";
import { db } from "../db/client.ts";
import { aMoveLanded, answerStarPrompt, starOnGitHub, starredOnGitHub } from "../github-star.ts";
import { NoWallet, WalletExists } from "../apps/contract.ts";
import { owner } from "../db/schema.ts";
import { postgresKnowsZone } from "../money/value-history.ts";
import {
  addMissingKey,
  missingAddress,
  noSolanaBring,
  revealWalletKeys,
  walletAddresses,
} from "../money/wallets.ts";

export const meRouter = Router();

/**
 * The owner as web reads them: their settings, the wallet's addresses (none until they make or
 * bring one, or while it can't be reached), what Auni thinks with, the chat apps it talks in,
 * how the owner reaches it, and whether to ask them for a star (github-star.ts).
 */
async function meWire(): Promise<z.input<typeof meSchema>> {
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

meRouter.get("/", async (_req, res) => {
  res.json(await meWire());
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
  if (Object.keys(patch).length > 0)
    await db.update(owner).set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.time_zone !== undefined ? { timeZone: patch.time_zone } : {}),
      ...(patch.home_channel !== undefined ? { homeChannel: patch.home_channel } : {}),
    });
  res.json(await meWire());
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
meRouter.post("/wallet/missing", async (_req, res) => {
  try {
    await addMissingKey();
  } catch (error) {
    if (error instanceof WalletExists || error instanceof NoWallet)
      return void res.status(409).json({ error: "nothing_missing" });
    throw error;
  }
  res.json(await meWire());
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
