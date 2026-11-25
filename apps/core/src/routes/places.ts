import { startChatRequestSchema, type startedChatWireSchema } from "@auni/shared";
import express, { Router } from "express";
import type { z } from "zod";

import { theOwner } from "../auth/owner.ts";
import { startChat } from "../conversation/places.ts";
import { readThreadWire } from "../conversation/threads.ts";
import { makeWalletIfNone } from "../money/wallets.ts";

/**
 * Every conversation with Auni is a thread. A new message from `/app/new` or
 * search starts one, with its initial title and composer controls.
 */
export const placesRouter = Router();
placesRouter.use(express.json({ limit: "64kb" }));

/**
 * A new thread, made with its first message (conversation/places.ts). A new owner's first take
 * makes the wallet they didn't bring, so it's there to add money to. One that can't be made now
 * never stops the chat: a question needs no wallet, and the first move makes it (money/actions.ts).
 */
placesRouter.post("/chat", async (req, res) => {
  const body = startChatRequestSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "invalid_body" });
  if ((await theOwner()).welcomedAt === null)
    await makeWalletIfNone().catch((error: unknown) =>
      console.error("The owner's wallet couldn't be made yet:", error),
    );
  const { id, messageId, text, modelSelection, actMode, budgetUsd } = body.data;
  const started = await startChat(
    { id, firstMessage: { id: messageId, text } },
    {
      ...(modelSelection !== undefined ? { modelSelection } : {}),
      ...(actMode !== undefined ? { actMode } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    },
  );
  const thread = await readThreadWire(started.thread.id);
  if (!thread) return void res.status(404).json({ error: "thread_not_found" });
  res.json({
    thread,
    ...(started.keyKeptOut ? { keyKeptOut: true as const } : {}),
  } satisfies z.input<typeof startedChatWireSchema>);
});
