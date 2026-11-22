import type { HandoverOffer, HandoverStatus } from "@auni/shared";
import express, { Router } from "express";
import { z } from "zod";

import { ownerHere } from "../auth/proof.ts";
import { cancelHandover, HandoverRefused, handoverState, offerHandover } from "./hand-over.ts";
import { readTailnet, type Tailnet } from "./tailnet.ts";

// Settings' "Keep Auni running when your laptop sleeps", under "Where Auni runs", which offers it
// where Auni isn't always on already (/me's reach; packages/shared/src/handover.ts).

export const handoverRouter = Router();

handoverRouter.use(express.json({ limit: "1kb" }));

const wire = (tailnet: Tailnet): HandoverStatus["tailnet"] =>
  tailnet.state === "on"
    ? {
        state: "on",
        machines: tailnet.machines.map(({ id, name, os, online, runsAuni, here }) => ({
          id,
          name,
          os,
          online,
          runsAuni,
          here,
        })),
      }
    : tailnet;

handoverRouter.get("/", async (_req, res) => {
  const status: HandoverStatus = {
    tailnet: wire(await readTailnet()),
    handover: handoverState(),
  };
  res.json(status);
});

/**
 * Opens a handover to one of the owner's machines, and answers the command to run there, once. It
 * hands the wallet's keys to that machine, so it takes the proof that showing them takes: the
 * request itself proves the owner is there (auth/proof.ts).
 */
handoverRouter.post("/", async (req, res) => {
  if (!ownerHere(req)) return void res.status(403).json({ error: "pair_again" });
  const body = z.object({ machine: z.string() }).safeParse(req.body);
  if (!body.success) return void res.status(400).json({ error: "invalid_body" });
  const tailnet = await readTailnet();
  if (tailnet.state !== "on") return void res.status(409).json({ error: "no_tailnet" });
  const picked = tailnet.machines.find(({ id }) => id === body.data.machine);
  if (!picked?.online || !picked.runsAuni)
    return void res.status(409).json({ error: "cannot_run_there" });
  try {
    const { command, expiresAt } = await offerHandover(picked, tailnet.here);
    res.setHeader("Cache-Control", "no-store");
    const offer: HandoverOffer = {
      command,
      machine: picked.name,
      expiresAt: expiresAt.toISOString(),
    };
    res.json(offer);
  } catch (error) {
    if (!(error instanceof HandoverRefused)) throw error;
    res.status(409).json({ error: "refused", message: error.message });
  }
});

handoverRouter.delete("/", (_req, res) => {
  if (!cancelHandover()) return void res.status(409).json({ error: "handing_over" });
  res.json({ ok: true });
});
