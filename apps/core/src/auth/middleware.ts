import type { NextFunction, Request, RequestHandler, Response } from "express";

import { env } from "../env.ts";
import { SESSION_COOKIE, sessionOf } from "./owner.ts";
import { cameAsOwner } from "./tailscale.ts";

declare global {
  // Express's documented pattern for augmenting `Request`.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** This owner's request proves the owner is there (auth/proof.ts), as requireOwner judged it. */
      ownerHere?: boolean;
      /** Current paired session row id in local mode (undefined under Tailscale). */
      sessionId?: string;
    }
  }
}

/**
 * Answers only requests addressed to this hub by a name it goes by, so a web page on some other
 * domain that points its DNS at 127.0.0.1 (DNS rebinding) can't reach it as same-origin.
 */
export function hostCheck(port: number): RequestHandler {
  const allowed = new Set([
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    `[::1]:${port}`,
    new URL(env.WEB_ORIGIN).host,
  ]);
  return (req, res, next) => {
    if (allowed.has(req.headers.host ?? "")) return next();
    res.status(421).json({ error: "unknown_host" });
  };
}

/** A request that changes something comes from Auni's own pages, never another site's form. */
export function fromTheApp(req: Request, res: Response, next: NextFunction): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || req.headers.origin === env.WEB_ORIGIN)
    return next();
  res.status(403).json({ error: "bad_origin" });
}

function cookie(req: Request, name: string): string | undefined {
  for (const pair of (req.headers.cookie ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at).trim() === name) return pair.slice(at + 1).trim();
  }
  return undefined;
}

/**
 * The owner's request, from a page of the app. Always on (TAILSCALE_OWNER), it is one the door
 * let in through Tailscale (auth/tailscale.ts), which also proves the owner is there, and nothing
 * else is: no cookie, and no request to core's own port. On this computer, it carries the
 * owner's session cookie. Where a request came from earns nothing: one from 127.0.0.1 without
 * what its mode takes is refused like any other.
 */
export async function requireOwner(req: Request, res: Response, next: NextFunction) {
  if (env.TAILSCALE_OWNER) {
    // `at`: the tailnet address that does open, which `auni` prints too, so a page turned away
    // here can say where to go.
    if (!cameAsOwner(req))
      return void res.status(401).json({ error: "tailscale_owner_only", at: env.WEB_ORIGIN });
    return fromTheApp(req, res, () => {
      req.ownerHere = true;
      next();
    });
  }
  const token = cookie(req, SESSION_COOKIE);
  const session = token ? await sessionOf(token) : null;
  if (!session) return void res.status(401).json({ error: "pairing_required" });
  fromTheApp(req, res, () => {
    req.ownerHere = session.freshlyPaired;
    req.sessionId = session.id;
    next();
  });
}

/**
 * Whether the session a request came with is still live, for a response that outlasts its
 * request (the live stream), so a browser signed out everywhere stops hearing at once.
 */
export async function stillSignedIn(req: Request): Promise<boolean> {
  // Through Tailscale, a device taken off the tailnet loses its connection, the stream with it.
  if (env.TAILSCALE_OWNER) return cameAsOwner(req);
  const token = cookie(req, SESSION_COOKIE);
  return token !== undefined && (await sessionOf(token)) !== null;
}
