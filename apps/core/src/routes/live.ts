import { Router } from "express";

import { stillSignedIn } from "../auth/middleware.ts";
import { onLive, type LiveMessage } from "../conversation/stream.ts";
import { onSettingsChange } from "../settings.ts";

/**
 * `GET /live`: everything that changes while a tab is open, as Server-Sent Events. One stream a
 * tab, whatever it shows, since a browser opens at most six connections to one host. Behind
 * requireOwner, through the web app's /core rewrite like every other request.
 */
export const liveRouter = Router();

// Well inside the /core rewrite's 120s idle timeout (apps/web/next.config.ts).
export const PING_MS = 15_000;
// How soon a browser comes back after the stream drops (core restarting, the network changing).
const RETRY_MS = 3_000;

liveRouter.get("/", (req, res) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    // no-transform, or the rewrite's compression holds the stream back to gzip it.
    "cache-control": "no-cache, no-transform",
  });
  // Nothing is written once the stream has ended: a write after end is an error event.
  const send = (text: string) => void (res.writableEnded || res.write(text));
  // Listening before the first byte goes, so a tab that sees the stream open hears everything
  // from then on: the chat sends its message only after that.
  const tell = (message: LiveMessage) => send(`data: ${JSON.stringify(message)}\n\n`);
  const stop = onLive(tell);
  // A key saved or an app switched, from this tab, another, or a card: each reads its apps again.
  const stopSettings = onSettingsChange(() => tell({ topic: "apps" }));
  send(`retry: ${RETRY_MS}\n\n`);
  // Each ping checks the session again, so a browser signed out everywhere hears no more.
  const ping = setInterval(() => {
    void stillSignedIn(req)
      .catch(() => false)
      .then((signedIn) => (signedIn ? send(": ping\n\n") : res.end()));
  }, PING_MS);
  res.on("close", () => {
    clearInterval(ping);
    stop();
    stopSettings();
  });
});
