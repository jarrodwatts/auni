import { Router } from "express";

import { pingDatabase } from "../db/client.ts";
import { browserTried } from "../open-browser.ts";
import { versionLine } from "../release/layout.ts";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  try {
    await pingDatabase();
    // How this Auni brought the owner's browser to it, which `auni setup` tells them, and which
    // Auni this is, which `auni doctor` holds to the code on disk (setup.ts).
    res.status(200).json({ status: "ok", browser: browserTried(), version: versionLine() });
  } catch {
    res.status(503).json({ status: "unavailable" });
  }
});
