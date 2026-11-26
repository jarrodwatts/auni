import type { StartingPointsWire } from "@auni/shared";
import { Router } from "express";

import { theOwner } from "../auth/owner.ts";
import { db } from "../db/client.ts";
import { forceRefreshStartingPoints, refreshStartingPoints } from "../jobs/kinds.ts";

/**
 * A new chat's starting points (conversation/starting-points.ts): those saved while they stand,
 * at once; past that, none, and new ones asked for, which `pending` says. Old ones are never
 * shown meanwhile, since a tap sends their numbers to Auni as the owner's own words.
 */
export const startingPointsRouter = Router();

startingPointsRouter.get("/", async (_req, res) => {
  const { startingPoints, startingPointsAt } = await theOwner();
  const pending = await refreshStartingPoints(db, startingPointsAt);
  const points = pending ? [] : (startingPoints ?? []);
  res.json({
    points,
    pending,
    observedAt: points.length > 0 && startingPointsAt ? startingPointsAt.toISOString() : null,
  } satisfies StartingPointsWire);
});

/** Queues a fresh starting-points generation right now, reusing an in-flight run if one is pending. */
startingPointsRouter.post("/refresh", async (_req, res) => {
  await forceRefreshStartingPoints(db, { reusePending: true });
  res.json({ points: [], pending: true, observedAt: null } satisfies StartingPointsWire);
});
