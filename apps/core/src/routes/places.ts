import { startChatRequestSchema, type startedChatWireSchema } from "@auni/shared";
import express, { Router } from "express";
import type { z } from "zod";

import { theOwner } from "../auth/owner.ts";
import { startChat } from "../conversation/places.ts";
import { readThreadWire } from "../conversation/threads.ts";
import { makeWalletIfNone } from "../money/wallets.ts";

/**
 * Every conversation with Auni is a thread. A new message from `/app/new` or
 * search starts a thread first with its initial title and composer controls.
 */
export const placesRouter = Router();
placesRouter.use(express.json({ limit: "64kb" }));

/**
 * A new thread, titled by its first message, which the web then sends there. A new owner's first
 * take is the first thing that can lead to a move, so the wallet they didn't bring is made before
 * its chat; one that can't be made starts no chat, and they stay in first run, free to bring one.
 */
placesRouter.post("/chat", async (req, res) => {
  const body = startChatRequestSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "invalid_body" });
  if ((await theOwner()).welcomedAt === null) {
    try {
      await makeWalletIfNone();
    } catch (error) {
      console.error("The owner's wallet couldn't be made:", error);
      return void res.status(502).json({ error: "wallet_not_made" });
    }
  }
  const chat = await startChat(body.data.text, {
    ...(body.data.modelSelection !== undefined ? { modelSelection: body.data.modelSelection } : {}),
    ...(body.data.actMode !== undefined ? { actMode: body.data.actMode } : {}),
    ...(body.data.budgetUsd !== undefined ? { budgetUsd: body.data.budgetUsd } : {}),
  });
  const thread = await readThreadWire(chat.id);
  if (!thread) return void res.status(404).json({ error: "thread_not_found" });
  res.json({ thread } satisfies z.input<typeof startedChatWireSchema>);
});
