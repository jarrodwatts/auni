import { startChatRequestSchema, type startedChatWireSchema } from "@auni/shared";
import express, { Router } from "express";
import { z } from "zod";

import { specialistThread, startChat } from "../conversation/places.ts";
import { readThreadWire } from "../conversation/threads.ts";

/**
 * Each specialist has one conversation; any other is a chat with Auni. A message goes to the
 * conversation it was typed in: a new one from the welcome or search starts a chat first.
 */
export const placesRouter = Router();
placesRouter.use(express.json({ limit: "64kb" }));

/** A new chat, titled by its first message, which the web then sends there. */
placesRouter.post("/chat", async (req, res) => {
  const body = startChatRequestSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "invalid_body" });
  const chat = await startChat(body.data.text);
  const thread = await readThreadWire(chat.id);
  if (!thread) return void res.status(404).json({ error: "thread_not_found" });
  res.json({ thread } satisfies z.input<typeof startedChatWireSchema>);
});

/** A specialist's one thread, made on first ask. */
placesRouter.post("/:specialistId/thread", async (req, res) => {
  const specialistId = z.uuid().safeParse(req.params.specialistId);
  const thread = specialistId.success ? await specialistThread(specialistId.data) : undefined;
  if (!thread) return void res.status(404).json({ error: "place_not_found" });
  res.json({ thread: await readThreadWire(thread.id) });
});
