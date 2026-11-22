import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it } from "vitest";

import { threads } from "../db/schema.ts";
import { env } from "../env.ts";
import { insertThread, wipe } from "../test/db.ts";
import { signTurnToken } from "./turn-token.ts";
import { requireTurnToken } from "./turn-token-middleware.ts";

const STARTED = new Date("2026-09-30T00:00:00.000Z");

beforeEach(() => wipe(threads));

/** Runs the middleware on a token for the turn on this thread started at `started`. */
async function call(threadId: string, started = STARTED) {
  const token = await signTurnToken(
    { threadId, turnStartedAt: started.toISOString() },
    env.TURN_TOKEN_SECRET,
  );
  const outcome: { status?: number; error?: string; passed: boolean } = { passed: false };
  const req = { header: () => `Bearer ${token}` } as unknown as Request;
  const res = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    json(body: { error: string }) {
      outcome.error = body.error;
    },
  } as unknown as Response;
  await requireTurnToken(req, res, (() => (outcome.passed = true)) as NextFunction);
  return outcome;
}

const ended = { passed: false, status: 401, error: "turn_ended" };

describe("requireTurnToken", () => {
  it("accepts a token while its turn is the thread's running turn", async () => {
    const thread = await insertThread({ turnStartedAt: STARTED });
    expect(await call(thread.id)).toEqual({ passed: true });
  });

  it("refuses a token once its turn was stopped or finished", async () => {
    const thread = await insertThread({ turnStartedAt: null });
    expect(await call(thread.id)).toEqual(ended);
  });

  it("refuses a token once a newer turn took the thread", async () => {
    const thread = await insertThread({
      turnStartedAt: new Date(STARTED.getTime() + 1_000),
    });
    expect(await call(thread.id)).toEqual(ended);
  });

  it("refuses a token on another thread, even mid-turn", async () => {
    await insertThread({ turnStartedAt: STARTED });
    const other = await insertThread({
      turnStartedAt: new Date(STARTED.getTime() + 1_000),
    });
    // The other thread's turn began elsewhen, so this turn's start works only on its own thread.
    expect(await call(other.id)).toEqual(ended);
  });
});
