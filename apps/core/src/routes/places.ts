import { startChatRequestSchema, type startedChatWireSchema } from "@auni/shared";
import express, { Router } from "express";
import type { z } from "zod";

import { startChat } from "../conversation/places.ts";
import { readThreadWire } from "../conversation/threads.ts";

/**
 * Every conversation with Auni is a thread. A new message from `/app/new` or
 * search starts a thread first with its initial title and composer controls.
 */
export const placesRouter = Router();
placesRouter.use(express.json({ limit: "64kb" }));

/** A new thread, titled by its first message, which the web then sends there. */
placesRouter.post("/chat", async (req, res) => {
  const body = startChatRequestSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "invalid_body" });
  const chat = await startChat(body.data.text, {
    ...(body.data.modelSelection !== undefined ? { modelSelection: body.data.modelSelection } : {}),
    ...(body.data.actMode !== undefined ? { actMode: body.data.actMode } : {}),
    ...(body.data.budgetUsd !== undefined ? { budgetUsd: body.data.budgetUsd } : {}),
  });
  const thread = await readThreadWire(chat.id);
  if (!thread) return void res.status(404).json({ error: "thread_not_found" });
  res.json({ thread } satisfies z.input<typeof startedChatWireSchema>);
});
