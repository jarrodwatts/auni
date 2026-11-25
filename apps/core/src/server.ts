import type { Server } from "node:http";

import express, { type Express } from "express";

import { mcpRouter } from "./agent/mcp.ts";
import { hostCheck, requireOwner } from "./auth/middleware.ts";
import { openDoor } from "./auth/tailscale.ts";
import { env } from "./env.ts";
import { appsRouter } from "./routes/apps.ts";
import { brainsRouter } from "./routes/brains.ts";
import { feedbackRouter } from "./routes/feedback.ts";
import { failed } from "./routes/failed.ts";
import { healthRouter } from "./routes/health.ts";
import { liveRouter } from "./routes/live.ts";
import { meRouter } from "./routes/me.ts";
import { ownerRouter } from "./routes/owner.ts";
import { privateRouter } from "./routes/private.ts";
import { setupRouter } from "./routes/setup.ts";
import { siteMarksRouter } from "./routes/site-marks.ts";
import { startingPointsRouter } from "./routes/starting-points.ts";
import { systemRouter } from "./routes/system.ts";
import {
  actionsRouter,
  activityRouter,
  portfolioRouter,
  proposalsRouter,
  takesRouter,
} from "./money/routes.ts";
import { withdrawalsRouter } from "./money/withdrawal-routes.ts";
import { whileHandingOver } from "./handover/hand-over.ts";
import { handoverRouter } from "./handover/routes.ts";
import { placesRouter } from "./routes/places.ts";
import { threadsRouter } from "./routes/threads.ts";
import { automationsRouter } from "./routes/automations.ts";
import { channelsRouter } from "./routes/channels.ts";

/** Core's HTTP API: its routes, each behind what it takes. */
export function coreApp(): Express {
  const app = express();

  // Before the Host check, so a platform's health probe under its own host name gets an answer.
  app.use(healthRouter);
  app.use(hostCheck(env.PORT));
  // While Auni is handed to another machine nothing changes here, and once it has moved every
  // request hears where it went (handover/hand-over.ts).
  app.use(whileHandingOver);
  app.use("/owner", ownerRouter);
  app.use("/me", requireOwner, meRouter);
  app.use("/private", requireOwner, privateRouter);
  app.use("/setup", requireOwner, setupRouter);
  app.use("/brains", requireOwner, brainsRouter);
  app.use("/threads", requireOwner, threadsRouter);
  app.use("/starting-points", requireOwner, startingPointsRouter);
  app.use("/live", requireOwner, liveRouter);
  app.use("/places", requireOwner, placesRouter);
  app.use("/actions", requireOwner, actionsRouter);
  app.use("/proposals", requireOwner, proposalsRouter);
  app.use("/portfolio", requireOwner, portfolioRouter);
  app.use("/activity", requireOwner, activityRouter);
  app.use("/takes", requireOwner, takesRouter);
  app.use("/withdrawals", requireOwner, withdrawalsRouter);
  app.use("/automations", requireOwner, automationsRouter);
  app.use("/channels", requireOwner, channelsRouter);
  app.use("/apps", requireOwner, appsRouter);
  app.use("/feedback", requireOwner, feedbackRouter);
  app.use("/site-marks", requireOwner, siteMarksRouter);
  app.use("/handover", requireOwner, handoverRouter);
  app.use("/system", requireOwner, systemRouter);
  // Called by the agent's CLI on this machine with the per-turn token, never the owner's session.
  app.use(mcpRouter);
  // Last: a body that isn't JSON is turned down, and a handler that throws is logged.
  app.use(failed);
  return app;
}

/**
 * The web app reaches core through Next's proxy, which keeps its connections to core open as long
 * as it likes and sends the next request down whichever is free. Node closes a connection it has
 * found idle for five seconds, and a request the proxy sent down one at that moment failed
 * (ECONNRESET), which the page got as a 500: the auni.io door's starting points did, on a busy
 * machine. So core leaves an idle connection to whoever opened it, which on this machine is the
 * web app or the agent's CLI; each closes its own, and stopping Auni closes the rest.
 */
export function keepIdleConnections(server: Server): void {
  server.keepAliveTimeout = 0;
}

/**
 * Core's HTTP API, listening on HOST:PORT once this resolves, and always on (TAILSCALE_OWNER) the
 * door Tailscale reaches it and the web app through (auth/tailscale.ts): each server it opened.
 */
export async function listen(): Promise<Server[]> {
  const app = coreApp();
  const api = await new Promise<Server>((resolve, reject) => {
    // Express 5 reports a failed bind (e.g. port in use) here instead of throwing.
    const server = app.listen(env.PORT, env.HOST, (error) =>
      error ? reject(error) : resolve(server),
    );
    keepIdleConnections(server);
  });
  if (!env.TAILSCALE_OWNER) return [api];
  try {
    return [api, await openDoor(app, env.TAILSCALE_OWNER)];
  } catch (error) {
    api.close();
    throw error;
  }
}
