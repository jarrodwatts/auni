import express, { Router } from "express";
import { z } from "zod";

import { fromTheApp } from "../auth/middleware.ts";
import { pair, sessionCookie } from "../auth/owner.ts";
import { env } from "../env.ts";

export const ownerRouter = Router();
ownerRouter.use(express.json({ limit: "4kb" }));

const pairBody = z.object({ code: z.string().min(1).max(200) });

/** Spends a pairing code from `auni` or `auni pair`, and makes this browser the owner's with a cookie. */
ownerRouter.post("/pair", fromTheApp, async (req, res) => {
  // Always on, Tailscale says who the owner is (auth/tailscale.ts), and no browser pairs.
  if (env.TAILSCALE_OWNER) return void res.status(404).json({ error: "pairing_off" });
  const body = pairBody.safeParse(req.body);
  const token = body.success ? await pair(body.data.code) : null;
  // One answer for wrong, spent and expired, so a guess learns nothing.
  if (!token) return void res.status(403).json({ error: "pairing_code_invalid" });
  res.setHeader("Set-Cookie", sessionCookie(token));
  res.status(204).end();
});
