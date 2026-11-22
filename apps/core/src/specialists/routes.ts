import {
  updateSpecialistRequestSchema,
  valueRangeSchema,
  type valueHistoryWireSchema,
} from "@auni/shared";
import express, { Router } from "express";
import { z } from "zod";

import { specialistUpdateWire, specialistUpdateById, undoSpecialistUpdate } from "./updates.ts";
import {
  specialistDetail,
  listSpecialistViews,
  specialistById,
  renameSpecialist,
  retireEmptySpecialist,
  updateSpecialist,
} from "./specialists.ts";
import { portfolioNow } from "../money/portfolio.ts";
import { valueHistory } from "../money/value-history.ts";

const uuid = z.uuid();

export const specialistsRouter = Router();
specialistsRouter.use(express.json({ limit: "4kb" }));

specialistsRouter.get("/", async (req, res) => {
  res.json({ specialists: await listSpecialistViews() });
});

specialistsRouter.get("/:id", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const specialist = id.success ? await specialistDetail(id.data, portfolioNow) : null;
  if (!specialist) return void res.status(404).json({ error: "specialist_not_found" });
  res.json({ specialist });
});

specialistsRouter.patch("/:id", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  // The rules dialog and the "…" menu's rename and retire: the owner's own changes, never a card's.
  const body = updateSpecialistRequestSchema.safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "invalid_body" });
  if (!id.success || !(await specialistById(id.data)))
    return void res.status(404).json({ error: "specialist_not_found" });
  const { retired, ...patch } = body.data;
  if (retired) {
    if (Object.keys(body.data).length > 1)
      return void res.status(400).json({ error: "invalid_body" });
    const outcome = await retireEmptySpecialist(id.data);
    if (outcome === "unreadable") return void res.status(503).json({ error: outcome });
    if (outcome !== "retired") return void res.status(409).json({ error: outcome });
    return void res.json({ specialist: await specialistDetail(id.data, portfolioNow) });
  }
  if (Object.values(patch).some((value) => value !== undefined)) {
    // A rename alone reaches a retired one too; how Auni acts only changes while it's active.
    const { actMode, ...names } = patch;
    const edited =
      actMode === undefined
        ? await renameSpecialist(id.data, names)
        : await updateSpecialist(id.data, patch);
    if (!edited) return void res.status(409).json({ error: "retired" });
  }
  res.json({ specialist: await specialistDetail(id.data, portfolioNow) });
});

/** One specialist over `?range=` (see valueRangeSchema). */
specialistsRouter.get("/:id/history", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  if (!id.success || !(await specialistById(id.data)))
    return void res.status(404).json({ error: "specialist_not_found" });
  const range = valueRangeSchema.safeParse(req.query.range);
  if (!range.success) return void res.status(400).json({ error: "invalid_range" });
  res.json(
    (await valueHistory(id.data, range.data)) satisfies z.input<typeof valueHistoryWireSchema>,
  );
});

/** A chat edit's receipt reads this to know whether it has been undone. */
specialistsRouter.get("/:id/updates/:updateId", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const updateId = uuid.safeParse(req.params.updateId);
  const update =
    id.success && updateId.success ? await specialistUpdateById(id.data, updateId.data) : undefined;
  if (!update) return void res.status(404).json({ error: "update_not_found" });
  res.json({ update: specialistUpdateWire(update) });
});

/**
 * Undo on a chat edit's receipt: its fields go back to what they were.
 * 409 `superseded` when a later change touched the same fields since, and
 * `widens` when it would leave it acting on its own wider than it stood then.
 */
specialistsRouter.post("/:id/updates/:updateId/undo", async (req, res) => {
  const id = uuid.safeParse(req.params.id);
  const updateId = uuid.safeParse(req.params.updateId);
  if (!id.success || !updateId.success)
    return void res.status(404).json({ error: "update_not_found" });
  const outcome = await undoSpecialistUpdate(id.data, updateId.data);
  if (outcome.status === "not_found")
    return void res.status(404).json({ error: "update_not_found" });
  if (outcome.status !== "undone") return void res.status(409).json({ error: outcome.status });
  res.json({
    update: specialistUpdateWire(outcome.update),
    specialist: await specialistDetail(id.data, portfolioNow),
  });
});
