import { setTimeout as sleep } from "node:timers/promises";

import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { db, inTurn } from "./client.ts";
import { env } from "../env.ts";
import { ownSession, SessionLost } from "./session.ts";

afterEach(() => vi.unstubAllEnvs());

const pidOf = async (session: ReturnType<typeof ownSession>) =>
  (await session<{ pid: number }[]>`select pg_backend_pid() as pid`)[0]!.pid;
const end = (pid: number) => db.execute(sql`select pg_terminate_backend(${pid}::int)`);

describe("ownSession", () => {
  it("stays the same session past the age and the idle time the library would close it at", async () => {
    // postgres.js closes a connection at 30 to 60 minutes old unless told otherwise: here, at 1 s.
    vi.stubEnv("PGMAX_LIFETIME", "1");
    vi.stubEnv("PGIDLE_TIMEOUT", "1");
    const session = ownSession(env.DATABASE_URL);
    try {
      const pid = await pidOf(session);
      await sleep(1_500);
      expect(await pidOf(session)).toBe(pid);
    } finally {
      await session.end();
    }
  });

  it("is never replaced by a new session once it is lost, and says so at once", async () => {
    const lost = vi.fn();
    const session = ownSession(env.DATABASE_URL, lost);
    try {
      await session`select pg_advisory_lock(hashtext('auni:test-session'))`;
      const pid = await pidOf(session);
      // A query in flight as the session ends fails, and so does one asked in the same breath,
      // which the library would have opened a new session for.
      const next = session`select pg_sleep(30)`.then(
        () => "answered",
        () => session`select 1`.then(() => "answered by a new session"),
      );
      await sleep(100);
      await end(pid);
      await expect(next).rejects.toBeInstanceOf(SessionLost);
      expect(lost).toHaveBeenCalledOnce();
      await expect(async () => session`select 1`).rejects.toBeInstanceOf(SessionLost);
      await expect(async () => session.begin((tx) => tx`select 1`)).rejects.toBeInstanceOf(
        SessionLost,
      );
    } finally {
      await session.end();
    }
    expect(lost).toHaveBeenCalledOnce();
  });

  it("doesn't count being closed as lost", async () => {
    const lost = vi.fn();
    const session = ownSession(env.DATABASE_URL, lost);
    await session`select 1`;
    await session.end();
    expect(lost).not.toHaveBeenCalled();
  });
});

describe("inTurn", () => {
  it("gives each holder its turn", async () => {
    const order: string[] = [];
    const hold = (name: string, ms: number) =>
      inTurn("auni:test-turn", async () => {
        order.push(`${name} in`);
        await sleep(ms);
        order.push(`${name} out`);
      });
    const first = hold("first", 200);
    await sleep(50);
    await Promise.all([first, hold("second", 0)]);
    expect(order).toEqual(["first in", "first out", "second in", "second out"]);
  });

  it("fails a turn whose session was lost, rather than let it carry on without its lock", async () => {
    // Postgres restarting mid-send: the next holder may be in its turn already, so this one's
    // next write (the journal of a send it is about to make) must not happen.
    const turn = inTurn("auni:test-turn", async (conn) => {
      const [own] = await conn.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      await end(own!.pid);
      await sleep(100);
      return conn.execute(sql`select 1`);
    });
    await expect(turn).rejects.toMatchObject({ cause: expect.any(SessionLost) });
  });
});
