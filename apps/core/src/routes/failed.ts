import type { NextFunction, Request, Response } from "express";

/** An error Express's body parser gives for a body it turned down: not JSON, too long, cut off. */
function isBodyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("type" in error)) return false;
  return typeof error.type === "string" && /^(entity|request|encoding|charset)\./u.test(error.type);
}

/**
 * Core's last handler, for a request nothing answered. A body the parser turned down is the
 * sender's mistake: it is answered 400 and never logged, since the parser's error carries the
 * raw body, which may hold what the owner typed. Anything else a handler threw is logged and
 * answered 500 without its stack.
 */
export function failed(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (isBodyError(error)) {
    if (res.headersSent) return next(error);
    return void res.status(400).json({ error: "invalid_body" });
  }
  console.error(`${req.method} ${req.path} failed:`, error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: "internal" });
}
