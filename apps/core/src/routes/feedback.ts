import type { feedbackWireSchema } from "@auni/shared";
import { Router } from "express";
import { z } from "zod";

import { appById } from "../apps/registry.ts";
import { bugReport } from "../feedback.ts";
import { actionById } from "../money/actions.ts";

/**
 * A report the owner starts themselves, with no turn behind it: from a failed card ("Report it",
 * `?action=<id>`) or an app's sheet ("Report a problem", `?app=<id>`). Core builds what it would
 * post exactly as it does for the agent's card (feedback.ts), and no brain is asked. It only
 * reads: nothing is recorded, and nothing leaves this machine until the owner posts it on GitHub.
 */
export const feedbackRouter = Router();

const asked = z.object({ action: z.uuid().optional(), app: z.string().max(60).optional() });

feedbackRouter.get("/", async (req, res) => {
  const parsed = asked.safeParse(req.query);
  if (!parsed.success) return void res.status(400).json({ error: "invalid_query" });
  const { action: id, app } = parsed.data;
  const action = id ? await actionById(id) : null;
  if (id && !action) return void res.status(404).json({ error: "unknown_action" });
  if (app && !appById(app)) return void res.status(404).json({ error: "unknown_app" });
  const feedback = await bugReport({ action: action ?? undefined, app });
  res.json({ feedback } satisfies z.input<typeof feedbackWireSchema>);
});
