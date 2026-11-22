import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";

import { db } from "../db/client.ts";
import { threads } from "../db/schema.ts";
import { env } from "../env.ts";
import { TURN_TOKEN_TTL_SECONDS, verifyTurnToken, type TurnTokenClaims } from "./turn-token.ts";

declare global {
  // Express's documented pattern for augmenting `Request`.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      turn?: TurnTokenClaims;
    }
  }
}

function bearerToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (!header?.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

/** A stop, its turn ending or the next beginning moves the marker, retiring every older token. */
async function turnStillActive(claims: TurnTokenClaims): Promise<boolean> {
  const [thread] = await db
    .select({ turnStartedAt: threads.turnStartedAt })
    .from(threads)
    .where(eq(threads.id, claims.threadId));
  return thread?.turnStartedAt?.toISOString() === claims.turnStartedAt;
}

export async function requireTurnToken(req: Request, res: Response, next: NextFunction) {
  const token = bearerToken(req);
  if (!token) {
    res.status(401).json({ error: "turn_token_required" });
    return;
  }

  let claims: TurnTokenClaims;
  try {
    claims = await verifyTurnToken(token, env.TURN_TOKEN_SECRET);
  } catch {
    res.status(401).json({ error: "turn_token_invalid" });
    return;
  }
  if (!(await turnStillActive(claims))) {
    res.status(401).json({ error: "turn_ended" });
    return;
  }
  req.turn = claims;
  next();
}

const TOKEN_LIFE_MS = TURN_TOKEN_TTL_SECONDS * 1_000;

/**
 * Caps the calls one turn makes on a shared key. The agent drives its tools as it
 * likes, and without a cap a loop on one would spend until the turn ends. A
 * request can count as several, as a batch does. Counts live in this API process;
 * one idle for longer than a token lives can't be called on again, so it is dropped.
 */
export function turnCallCounter(limit: number, what: string) {
  const turnCalls = new Map<
    string,
    { readonly turnStartedAt: string; readonly calls: number; readonly at: number }
  >();
  return (turn: Pick<TurnTokenClaims, "threadId" | "turnStartedAt">, count = 1): boolean => {
    const now = Date.now();
    const current = turnCalls.get(turn.threadId);
    // A superseded turn's late call (one that passed just before the next turn began) can't reset it.
    if (current && turn.turnStartedAt < current.turnStartedAt) return false;
    const same = current?.turnStartedAt === turn.turnStartedAt;
    if (!same) {
      for (const [threadId, entry] of turnCalls)
        if (now - entry.at > TOKEN_LIFE_MS) turnCalls.delete(threadId);
    }
    const before = same ? current.calls : 0;
    const calls = before + count;
    turnCalls.set(turn.threadId, { turnStartedAt: turn.turnStartedAt, calls, at: now });
    if (before <= limit && calls > limit) console.warn(`turn spent its ${what}`, turn.threadId);
    return calls <= limit;
  };
}
