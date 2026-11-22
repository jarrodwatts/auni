import express, { Router, type Request } from "express";
import { z } from "zod";

import {
  automationById,
  automationWire,
  deleteAutomation,
  listAutomations,
  listFires,
  pauseAutomation,
  resumeAutomation,
} from "../automations/automations.ts";

const uuid = z.uuid();

export const automationsRouter = Router();

/** ?thread_id= or ?specialist_id= narrows a list; null when either isn't an id. */
function listFilter(query: Request["query"]) {
  const threadId = query.thread_id === undefined ? undefined : uuid.safeParse(query.thread_id);
  const specialistId =
    query.specialist_id === undefined ? undefined : uuid.safeParse(query.specialist_id);
  if (threadId?.success === false || specialistId?.success === false) return null;
  return {
    ...(threadId ? { threadId: threadId.data } : {}),
    ...(specialistId ? { specialistId: specialistId.data } : {}),
  };
}

automationsRouter.get("/", async (req, res) => {
  const filter = listFilter(req.query);
  if (!filter) {
    res.status(400).json({ error: "invalid_filter" });
    return;
  }
  const rows = await listAutomations(filter);
  res.json({ automations: rows.map(automationWire) });
});

/** When watches fired and what Auni said. */
automationsRouter.get("/fires", async (req, res) => {
  const filter = listFilter(req.query);
  if (!filter) {
    res.status(400).json({ error: "invalid_filter" });
    return;
  }
  res.json({ fires: await listFires(filter) });
});

automationsRouter.get("/:id", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const row = id.success ? await automationById(id.data) : undefined;
  if (!row) {
    res.status(404).json({ error: "automation_not_found" });
    return;
  }
  res.json({ automation: automationWire(row) });
});

const pauseBody = z.object({ paused: z.boolean() });

/** Pauses a watch, or resumes one that was paused. */
automationsRouter.patch("/:id", express.json({ limit: "2kb" }), async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const body = pauseBody.safeParse(req.body);
  const row = id.success ? await automationById(id.data) : undefined;
  if (!body.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }
  if (!row || row.status === "deleted") {
    res.status(404).json({ error: "automation_not_found" });
    return;
  }
  const from = body.data.paused ? "active" : "paused";
  if (row.status !== from) {
    res.status(409).json({ error: "automation_not_" + from });
    return;
  }
  try {
    const changed = body.data.paused ? await pauseAutomation(row) : await resumeAutomation(row);
    res.json({ automation: automationWire(changed) });
  } catch (error) {
    console.error("automation pause change failed", error);
    res.status(502).json({ error: "automation_pause_failed" });
  }
});

automationsRouter.delete("/:id", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const row = id.success ? await automationById(id.data) : undefined;
  if (!row || row.status === "deleted") {
    res.status(404).json({ error: "automation_not_found" });
    return;
  }
  try {
    res.json({ automation: automationWire(await deleteAutomation(row)) });
  } catch (error) {
    console.error("automation delete failed", error);
    res.status(502).json({ error: "automation_delete_failed" });
  }
});
