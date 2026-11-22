import type { BrainRowWire, BrainsWire } from "@auni/shared";
import { Router } from "express";
import { hostname } from "node:os";

import type { BrainRow } from "../agent/brain.ts";
import { brainTask, helpFor, startInstall, startSignIn, stopTask } from "../agent/sign-in.ts";
import { brainsFact } from "../setup.ts";

/**
 * The owner's AI from any device (agent/sign-in.ts): every brain app as it stands, with what Auni
 * is doing for it, and the asks that install its CLI or start its own sign-in, behind
 * requireOwner. A line typed into a sign-in goes by its private field (routes/private.ts), never
 * here.
 */
export const brainsRouter = Router();

/** A brain the owner just signed in to turns ready within seconds on a screen that waits on it. */
export const LOGIN_SEEN_MS = 3_000;

export function brainRowWire(row: BrainRow): BrainRowWire {
  return row.state === "resting" ? { ...row, until: row.until.toISOString() } : row;
}

async function brainsWire(): Promise<BrainsWire> {
  const { rows, blocked } = await brainsFact({ notReadyFreshMs: LOGIN_SEEN_MS });
  return {
    rows: rows.map((row) => ({ row: brainRowWire(row), task: brainTask(row.id), ...helpFor(row) })),
    blocked,
    // This computer, by the name the owner's other devices know it: "home-server".
    machine: hostname().split(".")[0]!,
  };
}

brainsRouter.get("/", async (_req, res) => {
  res.json(await brainsWire());
});

/** Starts the brain's own sign-in, or says it can't (no such brain, or one is already running). */
brainsRouter.post("/:id/sign-in", async (req, res) => {
  if (!startSignIn(req.params.id)) return void res.status(409).json({ error: "cant_sign_in" });
  res.json(await brainsWire());
});

brainsRouter.post("/:id/install", async (req, res) => {
  if (!startInstall(req.params.id)) return void res.status(409).json({ error: "cant_install" });
  res.json(await brainsWire());
});

/** Stops a sign-in or an install, or puts away one that failed. */
brainsRouter.delete("/:id/task", async (req, res) => {
  stopTask(req.params.id);
  res.json(await brainsWire());
});
