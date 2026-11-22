import { RETRACTED } from "@auni/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, specialists, threads } from "../db/schema.ts";
import { insertAction, insertSpecialist, insertThread, wipe } from "../test/db.ts";
import { retireEmptySpecialist, listSpecialistViews, renameSpecialist } from "./specialists.ts";
import type { Holding, Portfolio } from "../money/portfolio.ts";

// The live read is a stub: each test says what the specialist holds and whether every venue answered.
const read = vi.hoisted(() => ({
  holdings: [] as Partial<Holding>[],
  unavailable: [] as string[],
  looking: [],
  specialistId: "",
}));
vi.mock("../money/portfolio.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readPortfolio: async (): Promise<Partial<Portfolio>> => ({
    unavailable: read.unavailable,
    specialists: [
      {
        id: read.specialistId,
        purpose: "",
        status: "active",
        usdValue: "0.00",
        holdings: read.holdings as Holding[],
        whole: read.unavailable.length === 0,
      },
    ],
  }),
  portfolioNow: async (): Promise<Partial<Portfolio>> => ({
    unavailable: [],
    looking: [],
    specialists: [],
  }),
}));
vi.mock("../automations/automations.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deleteSpecialistAutomations: async () => {},
}));

beforeEach(async () => {
  read.holdings = [];
  read.unavailable = [];
  await wipe(specialists, actions, threads);
});

const status = async (id: string) =>
  (await db.select().from(specialists).where(eq(specialists.id, id)))[0]?.status;

async function setUp() {
  const specialist = await insertSpecialist();
  read.specialistId = specialist.id;
  return { specialist };
}

describe("retireEmptySpecialist", () => {
  it("retires one that holds nothing, with no report, and takes back what still waits on the person", async () => {
    const { specialist } = await setUp();
    const proposal = await insertAction({
      specialistId: specialist.id,
      status: "awaiting_permission",
    });
    expect(await retireEmptySpecialist(specialist.id)).toBe("retired");
    const [retired] = await db.select().from(specialists).where(eq(specialists.id, specialist.id));
    expect(retired).toMatchObject({ status: "retired", report: null });
    expect(retired?.retiredAt).toBeInstanceOf(Date);
    const [takenBack] = await db.select().from(actions).where(eq(actions.id, proposal.id));
    expect(takenBack).toMatchObject({ status: "retracted", error: RETRACTED.retired });
  });

  it("retires one whose only holding is worth nothing", async () => {
    const { specialist } = await setUp();
    read.holdings = [{ usdValue: "0.00" }];
    expect(await retireEmptySpecialist(specialist.id)).toBe("retired");
  });

  it("keeps one active while it holds money, priced or not", async () => {
    const { specialist } = await setUp();
    read.holdings = [{ usdValue: "0.01" }];
    expect(await retireEmptySpecialist(specialist.id)).toBe("holds_money");
    read.holdings = [{ usdValue: null }];
    expect(await retireEmptySpecialist(specialist.id)).toBe("holds_money");
    expect(await status(specialist.id)).toBe("active");
  });

  it("keeps one active while a move runs in it", async () => {
    const { specialist } = await setUp();
    await insertAction({ specialistId: specialist.id, status: "running" });
    expect(await retireEmptySpecialist(specialist.id)).toBe("in_flight");
    expect(await status(specialist.id)).toBe("active");
  });

  it("keeps one active while a move that just settled may not show on chain yet, and declines nothing", async () => {
    const { specialist } = await setUp();
    await insertAction({ specialistId: specialist.id, status: "done" });
    const proposal = await insertAction({
      specialistId: specialist.id,
      status: "awaiting_permission",
    });
    expect(await retireEmptySpecialist(specialist.id)).toBe("in_flight");
    expect(await status(specialist.id)).toBe("active");
    const [kept] = await db.select().from(actions).where(eq(actions.id, proposal.id));
    expect(kept?.status).toBe("awaiting_permission");
  });

  it("retires one whose last move settled long ago", async () => {
    const { specialist } = await setUp();
    await insertAction({
      specialistId: specialist.id,
      status: "done",
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    expect(await retireEmptySpecialist(specialist.id)).toBe("retired");
  });

  it("keeps one active while a move that settled since its read began may not show in it", async () => {
    const { specialist } = await setUp();
    await insertAction({
      specialistId: specialist.id,
      status: "done",
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    // The read began 11 minutes ago, before that move settled.
    vi.spyOn(Date, "now").mockReturnValueOnce(Date.now() - 11 * 60_000);
    expect(await retireEmptySpecialist(specialist.id)).toBe("in_flight");
  });

  it("keeps one active while a move runs, however long it has been stuck", async () => {
    const { specialist } = await setUp();
    await insertAction({
      specialistId: specialist.id,
      status: "running",
      updatedAt: new Date(Date.now() - 60 * 60_000),
    });
    expect(await retireEmptySpecialist(specialist.id)).toBe("in_flight");
  });

  it("keeps one active when a venue can't be read", async () => {
    const { specialist } = await setUp();
    read.unavailable = ["polymarket"];
    expect(await retireEmptySpecialist(specialist.id)).toBe("unreadable");
    expect(await status(specialist.id)).toBe("active");
  });

  it("won't retire one already retired", async () => {
    const { specialist } = await setUp();
    expect(await retireEmptySpecialist(specialist.id)).toBe("retired");
    expect(await retireEmptySpecialist(specialist.id)).toBe("already_retired");
  });
});

describe("renameSpecialist", () => {
  it("renames a retired one, and its conversation with it", async () => {
    const { specialist } = await setUp();
    const thread = await insertThread({ specialistId: specialist.id, title: "AI" });
    expect(await retireEmptySpecialist(specialist.id)).toBe("retired");
    const renamed = await renameSpecialist(specialist.id, { name: "Robots" });
    expect(renamed).toMatchObject({ name: "Robots", status: "retired" });
    const [after] = await db.select().from(threads).where(eq(threads.id, thread.id));
    expect(after?.title).toBe("Robots");
  });
});

describe("listSpecialistViews", () => {
  it("lists every specialist, newest first, retired ones included", async () => {
    const { specialist } = await setUp();
    const thread = await insertThread({ specialistId: specialist.id });
    await retireEmptySpecialist(specialist.id);
    const newer = await insertSpecialist({ createdAt: new Date(Date.now() + 1_000) });
    const listed = async () =>
      (await listSpecialistViews()).map(({ id, status }) => ({ id, status }));
    const both = [
      { id: newer.id, status: "active" },
      { id: specialist.id, status: "retired" },
    ];
    expect(await listed()).toEqual(both);
    // Its conversation archived, it is still on the record.
    await db.update(threads).set({ archivedAt: new Date() }).where(eq(threads.id, thread.id));
    expect(await listed()).toEqual(both);
  });

  it("names the chat whose card started each one, never its own conversation", async () => {
    const { specialist } = await setUp();
    const chat = await insertThread({ title: "Peptides go mainstream by 2028" });
    const own = await insertThread({ specialistId: specialist.id });
    await insertAction({
      specialistId: specialist.id,
      threadId: chat.id,
      status: "done",
      createdAt: new Date(Date.now() - 60_000),
    });
    await insertAction({ specialistId: specialist.id, threadId: own.id, status: "done" });
    const unstarted = await insertSpecialist();
    const views = await listSpecialistViews();
    expect(views.find(({ id }) => id === specialist.id)?.startedIn).toBe(chat.id);
    expect(views.find(({ id }) => id === unstarted.id)?.startedIn).toBeNull();
  });
});
