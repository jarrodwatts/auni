import { switchAppRequestSchema } from "@auni/shared";
import express, { Router } from "express";

import { appsWire, staysOn } from "../app-list.ts";
import { appById, hasSwitch } from "../apps/registry.ts";
import { PrivateFieldRefused } from "../private-fields.ts";
import { saveSwitch } from "../settings.ts";

/**
 * The apps in this Auni as the owner sees them (app-list.ts), and the switch that turns one off,
 * behind requireOwner. A setting's value never leaves core: a secret goes in through its private
 * field (routes/private.ts), and this says only whether it is set.
 */
export const appsRouter = Router();
appsRouter.use(express.json({ limit: "4kb" }));

appsRouter.get("/", async (_req, res) => {
  res.json(await appsWire());
});

appsRouter.patch("/:id", async (req, res) => {
  const parsed = switchAppRequestSchema.safeParse(req.body);
  if (!parsed.success) return void res.status(400).json({ error: "invalid_body" });
  const app = appById(req.params.id);
  if (!app) return void res.status(404).json({ error: "unknown_app" });
  if (!hasSwitch(app)) return void res.status(409).json({ error: "no_switch" });
  if (!parsed.data.on) {
    const message = await staysOn(app);
    if (message) return void res.status(409).json({ error: "in_use", message });
  }
  try {
    await saveSwitch(app.about.id, parsed.data.on);
  } catch (error) {
    // The settings file couldn't be changed safely, or this computer's environment sets the list.
    if (!(error instanceof PrivateFieldRefused)) throw error;
    return void res.status(409).json({ error: "refused", message: error.message });
  }
  res.json(await appsWire());
});
