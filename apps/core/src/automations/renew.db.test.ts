import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { appTroublesNow } from "../app-troubles.ts";
import { OutOfCredits } from "../apps/contract.ts";
import { appTroubles, automations, specialists, threads } from "../db/schema.ts";
import { insertSpecialist, insertThread, wipe } from "../test/db.ts";
import { createAutomation } from "./automations.ts";
import { expireWatches, remoteWatchIds, renewWatch } from "./renew.ts";

// Elfa is the source that keeps watches itself; its API is faked over fetch.

beforeEach(() => wipe(threads, automations, specialists, appTroubles));
afterEach(() => {
  process.env.ELFA_AUTO_API_KEY = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const news = { AND: [{ source: "events", args: { entity: "Micron" } }] };

interface Elfa {
  credits: boolean;
  valid: boolean;
  status: string;
  created: number;
  readonly asked: string[];
}

/** Elfa answering as `state` says, numbering the queries it creates and keeping what was asked. */
function fakeElfa(state: Partial<Elfa> = {}): Elfa {
  process.env.ELFA_AUTO_API_KEY = "elfa-test";
  const elfa: Elfa = {
    credits: true,
    valid: true,
    status: "active",
    created: 0,
    asked: [],
    ...state,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const path = new URL(input).pathname;
      const method = init?.method ?? "GET";
      elfa.asked.push(`${method} ${path}`);
      if (!elfa.credits)
        return Response.json({ code: "ERR_INSUFFICIENT_CREDITS" }, { status: 402 });
      if (path.endsWith("/validate"))
        return elfa.valid
          ? Response.json({ valid: true })
          : Response.json({ valid: false, errors: [{ code: "EQL_INVALID_ARG_VALUE" }] });
      if (method === "POST" && path === "/v2/auto/queries")
        return Response.json({ queryId: `query-${++elfa.created}` });
      const ref = /^\/v2\/auto\/queries\/([^/]+)$/u.exec(path)?.[1];
      if (method === "GET" && ref) return Response.json({ queryId: ref, status: elfa.status });
      return Response.json({});
    }),
  );
  return elfa;
}

async function newsWatch(fields: { expiresAt?: Date | null; specialistId?: string } = {}) {
  const thread = await insertThread();
  return createAutomation({
    threadId: thread.id,
    specialistId: fields.specialistId ?? null,
    source: "elfa",
    thesis: false,
    condition: news,
    description: "News on Micron",
    note: "They hold MU.",
    repeat: "0",
    expiresAt: fields.expiresAt ?? null,
  });
}

const stored = async (id: string) =>
  (await db.select().from(automations).where(eq(automations.id, id)))[0]!;

describe("a watch Elfa keeps", () => {
  it("is leased for Elfa's longest, sent its stream's action on a laptop", async () => {
    const elfa = fakeElfa();
    const watch = await newsWatch();
    expect(watch).toMatchObject({ status: "active", sourceRef: "query-1" });
    expect(watch.leaseUntil!.getTime()).toBeGreaterThan(Date.now() + 719 * 3_600_000);
    const create = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST")!;
    const body = JSON.parse(String(create[1]!.body)) as {
      query: { actions: { type: string }[]; expiresIn: string; repeat: unknown };
    };
    expect(body.query).toMatchObject({
      expiresIn: "720h",
      actions: [{ type: "notify" }],
      repeat: { cooldown: "0", maxTriggers: 1_000 },
    });
    expect(elfa.asked[0]).toBe("POST /v2/auto/queries/validate");
  });

  it("isn't set up while Elfa is out of credits, which Elfa's sheet and doctor then say", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fakeElfa({ credits: false });
    await expect(newsWatch()).rejects.toThrow(OutOfCredits);
    expect(await db.select().from(automations)).toEqual([]);
    expect(await appTroublesNow()).toMatchObject([{ app: "elfa", kind: "credits" }]);
  });

  it("waits while Elfa's credits run out under it, and is renewed once they are back", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const elfa = fakeElfa();
    const watch = await newsWatch();
    await db
      .update(automations)
      .set({ leaseUntil: new Date(Date.now() + 3_600_000) })
      .where(eq(automations.id, watch.id));
    elfa.credits = false;
    expect(await renewWatch(watch.id)).toBe("out of credits; tries again next run");
    expect(await stored(watch.id)).toMatchObject({ status: "active" });
    expect(await appTroublesNow()).toMatchObject([{ app: "elfa", kind: "credits" }]);
    elfa.credits = true;
    expect(await renewWatch(watch.id)).toBe("renewed");
    expect(await stored(watch.id)).toMatchObject({ status: "active", sourceRef: "query-2" });
    expect(await appTroublesNow()).toEqual([]);
  });

  it("is left be while Elfa watches it and its lease runs on", async () => {
    const elfa = fakeElfa();
    const watch = await newsWatch();
    expect(await renewWatch(watch.id)).toBe("watching");
    expect(elfa.created).toBe(1);
  });

  it("gets a fresh query before its lease ends, and the old one is removed", async () => {
    const elfa = fakeElfa();
    const watch = await newsWatch();
    await db
      .update(automations)
      .set({ leaseUntil: new Date(Date.now() + 3_600_000) })
      .where(eq(automations.id, watch.id));
    expect(await renewWatch(watch.id)).toBe("renewed");
    expect(await stored(watch.id)).toMatchObject({ sourceRef: "query-2" });
    expect(elfa.asked).toContain("DELETE /v2/auto/queries/query-1");
  });

  it("isn't renewed when it ends before its lease does", async () => {
    fakeElfa();
    const watch = await newsWatch({ expiresAt: new Date(Date.now() + 2 * 3_600_000) });
    // Two hours wanted, so Elfa's 2h query covers it.
    expect(watch.leaseUntil!.getTime()).toBeLessThan(Date.now() + 2 * 3_600_000 + 60_000);
    expect(await renewWatch(watch.id)).toBe("watching");
  });

  it("is replaced when Elfa stopped watching it", async () => {
    const elfa = fakeElfa();
    const watch = await newsWatch();
    elfa.status = "failed";
    expect(await renewWatch(watch.id)).toBe("renewed");
    expect(await stored(watch.id)).toMatchObject({ status: "active", sourceRef: "query-2" });
  });

  it("fails, rather than being tried every run, when Elfa now turns its condition down", async () => {
    const elfa = fakeElfa();
    const watch = await newsWatch();
    elfa.status = "failed";
    elfa.valid = false;
    expect(await renewWatch(watch.id)).toBe("refused; failed");
    expect(await stored(watch.id)).toMatchObject({ status: "failed" });
    expect(await remoteWatchIds()).toEqual([]);
  });

  it("is deleted once its specialist retired", async () => {
    const elfa = fakeElfa();
    const specialist = await insertSpecialist({ status: "retired" });
    const thread = await insertThread();
    const watch = await createAutomation({
      threadId: thread.id,
      specialistId: specialist.id,
      source: "elfa",
      thesis: true,
      condition: news,
      description: "Micron's thesis",
      note: "The thesis check.",
      repeat: null,
      expiresAt: null,
    });
    expect(await renewWatch(watch.id)).toBe("specialist retired; deleted");
    expect(await stored(watch.id)).toMatchObject({ status: "deleted" });
    expect(elfa.asked).toContain("DELETE /v2/auto/queries/query-1");
  });
});

describe("expireWatches", () => {
  it("ends watches past their end and removes what Elfa still keeps for them", async () => {
    const elfa = fakeElfa();
    const ending = await newsWatch({ expiresAt: new Date(Date.now() + 60_000) });
    const going = await newsWatch();
    await db
      .update(automations)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(automations.id, ending.id));

    expect(await expireWatches()).toBe(1);
    expect(await stored(ending.id)).toMatchObject({ status: "expired" });
    expect(await stored(going.id)).toMatchObject({ status: "active" });
    expect(elfa.asked).toContain(`DELETE /v2/auto/queries/${ending.sourceRef}`);
  });
});
