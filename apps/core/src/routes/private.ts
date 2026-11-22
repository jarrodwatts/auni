import express, { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import { ownerHere } from "../auth/proof.ts";
import { secretSaved } from "../money/decide.ts";
import {
  fieldWire,
  privateField,
  PrivateFieldRefused,
  type PrivateField,
  type PrivateValues,
} from "../private-fields.ts";

/**
 * Private fields (private-fields.ts): a secret the owner typed, taken by core and kept from
 * everything else. Nothing here echoes a value: a refusal says its fixed message, and any other
 * failure is logged and answered without the error, which could quote what was typed. A field
 * that takes proof the owner is there turns away a request without it at every step, from
 * drawing the field on, so the owner learns what it takes before pasting anything.
 */
export const privateRouter = Router();
// No answer is cached anywhere on the way, and none carries a value anyway.
privateRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
privateRouter.use(express.json({ limit: "4kb" }));

/** The field this request may type into, or null once it was answered no. */
async function fieldFor(req: Request, res: Response): Promise<PrivateField | null> {
  const field = await privateField(String(req.params.id));
  if (!field) res.status(404).json({ error: "unknown_field" });
  else if (field.proof && !ownerHere(req)) res.status(403).json({ error: "pair_again" });
  else return field;
  return null;
}

const bodySchema = z.object({ values: z.record(z.string(), z.string().max(1_000)) });

/** The values, each named by one of the field's inputs; null for anything else. */
function valuesFor(field: PrivateField, body: unknown): PrivateValues | null {
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return null;
  const names = new Set(field.inputs.map(({ name }) => name));
  return Object.keys(parsed.data.values).every((name) => names.has(name))
    ? parsed.data.values
    : null;
}

/** Runs one of the field's steps, answering a refusal with its message and anything else bare. */
async function answer(res: Response, field: PrivateField, step: () => Promise<void>) {
  try {
    await step();
  } catch (error) {
    if (error instanceof PrivateFieldRefused)
      return void res.status(400).json({ error: "refused", message: error.message });
    console.error(`private field ${field.id} failed`);
    res.status(500).json({ error: "internal" });
  }
}

/** What the field takes and what it says, and whether this request may type into it at all. */
privateRouter.get("/:id", async (req, res) => {
  const field = await fieldFor(req, res);
  if (field) res.json(fieldWire(field));
});

privateRouter.post("/:id/check", async (req, res) => {
  const field = await fieldFor(req, res);
  if (!field) return;
  const values = valuesFor(field, req.body);
  if (!values) return void res.status(400).json({ error: "invalid_body" });
  await answer(res, field, async () => void res.json(await field.check(values)));
});

// Taken, it answers every card that asked the agent's way for this field (money/decide.ts).
privateRouter.post("/:id", async (req, res) => {
  const field = await fieldFor(req, res);
  if (!field) return;
  const values = valuesFor(field, req.body);
  if (!values) return void res.status(400).json({ error: "invalid_body" });
  await answer(res, field, async () => {
    const said = await field.accept(values);
    await secretSaved(field.id);
    res.json({ said });
  });
});

const clearSchema = z.object({ input: z.string().max(100) });

privateRouter.post("/:id/clear", async (req, res) => {
  const field = await fieldFor(req, res);
  if (!field) return;
  const body = clearSchema.safeParse(req.body);
  if (!field.clear || !body.success) return void res.status(400).json({ error: "invalid_body" });
  const clear = field.clear.bind(field);
  await answer(res, field, async () => {
    await clear(body.data.input);
    res.json({ said: null });
  });
});

// A body that isn't JSON, or is too long, is turned down here rather than by the server's own
// handler, which logs the error: the JSON parser's carries the raw body.
privateRouter.use((_error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: "invalid_body" });
});
