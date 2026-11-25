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

/** How long a first take waits for its wallet before its chat starts without one. */
const WALLET_WAIT_MS = 2_000;

/**
 * A new thread, made with its first message (conversation/places.ts). A new owner's first take
 * makes the wallet they didn't bring, so it's there to add money to. One that can't be made now,
 * or is slow to, never stops the chat: a question needs no wallet, and the first move makes it
 * (money/actions.ts).
 */
placesRouter.post("/chat", async (req, res) => {
  const body = startChatRequestSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "invalid_body" });
  if ((await theOwner()).welcomedAt === null) await makeWalletWithin(WALLET_WAIT_MS);
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

/**
 * Makes the owner's wallet unless there is one, waiting at most `ms`. A try still out then
 * carries on, and open tabs hear of the wallet once it's made; a move that comes first makes
 * it itself, and the wallet app makes one wallet however many ask at once (WalletProvider.create).
 */
async function makeWalletWithin(ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    makeWalletIfNone().catch((error: unknown) =>
      console.error("The owner's wallet couldn't be made yet:", error),
    ),
    new Promise((resolve) => (timer = setTimeout(resolve, ms))),
  ]);
  clearTimeout(timer);
}
