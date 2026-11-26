import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AskToolName } from "@auni/shared";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { toolsFor } from "./agent/mcp.ts";
import { systemPrompt } from "./agent/prompt.ts";
import { routinesDir } from "./agent/routines.ts";
import { appsToOffer, declinedOffers } from "./connect.ts";
import { db } from "./db/client.ts";
import { actions, jobs, threads } from "./db/schema.ts";
import { executeAction } from "./money/actions.ts";
import { allowAction, declineAction } from "./money/decide.ts";
import { appsOff } from "./settings.ts";
import { insertThread, wipe } from "./test/db.ts";
import { queued } from "./test/jobs.ts";

// Every ask goes the way a money card does: a tool only records it waiting, and only the owner's
// Allow (money/decide.ts) applies it, in that one transaction, with nothing queued to run.

// The owner's settings file is one of this test's own: a connect card writes to it.
let home: string;
const realHome = process.env.AUNI_HOME;
/** The settings an app in these tests reads, which no test may leave set. */
const SETTINGS = ["APPS_OFF", "ELFA_AUTO_API_KEY"];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "auni-asks-"));
  process.env.AUNI_HOME = home;
  for (const name of SETTINGS) delete process.env[name];
  rmSync(routinesDir(), { recursive: true, force: true });
  await wipe(threads, actions, jobs);
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  process.env.AUNI_HOME = realHome;
  for (const name of SETTINGS) delete process.env[name];
});

/** The main button of each card a tool made, by its action. */
const buttons = new Map<string, string>();

/** Calls one of a turn's tools as the agent would, in the given thread. */
async function call(threadId: string, name: string, input: object) {
  const outcome = await answer(threadId, name, input);
  const card = (
    outcome.structuredContent as
      { card?: { actionReference?: string; action?: string } } | undefined
  )?.card;
  if (!card?.actionReference) throw new Error(`no ask card: ${JSON.stringify(outcome)}`);
  buttons.set(card.actionReference, card.action ?? "");
  return card.actionReference;
}

/** What one of a turn's tools answers the agent, card or refusal. */
async function answer(threadId: string, name: string, input: object) {
  const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
  const tool = toolsFor({ thread: thread! }).find((each) => each.name === name);
  return tool!.handler(input as never);
}

interface Case {
  readonly ask: AskToolName;
  /** Its main button, named for what the tap does, never a bare "Allow". */
  readonly button: string;
  /** Has an agent ask for it: the waiting row, and the thread it asked in. */
  propose(): Promise<{ readonly actionId: string; readonly threadId: string }>;
  /** Whether what it asks for has happened. */
  applied(): Promise<boolean>;
}

const AUTONOMY: Case = {
  ask: "set_thread_autonomy",
  button: "Auto up to $500",
  async propose() {
    const thread = await insertThread({ budgetUsd: "100" });
    const actionId = await call(thread.id, "set_thread_autonomy", {
      act_mode: "within_limits",
      budget_usd: 500,
    });
    return { actionId, threadId: thread.id };
  },
  async applied() {
    const [row] = await db.select().from(threads);
    return row?.actMode === "within_limits" && row.budgetUsd === "500.00";
  },
};

const ROUTINE: Case = {
  ask: "save_routine",
  button: "Save Check rates",
  async propose() {
    const thread = await insertThread({ title: "Idle cash" });
    const actionId = await call(thread.id, "save_routine", {
      name: "check-rates",
      description: "Load when moving idle cash between savings markets.",
      body: "Read every Aave market's rate, and move only for half a point or more.",
    });
    return { actionId, threadId: thread.id };
  },
  async applied() {
    return existsSync(join(routinesDir(), "check-rates", "SKILL.md"));
  },
};

const WHY = "I could show you where the crowd is betting on this.";

/** An app the owner turned off, which Auni offers back. */
const CONNECT: Case = {
  ask: "connect_app",
  button: "Turn Aave on",
  async propose() {
    process.env.APPS_OFF = "aave";
    const chat = await insertThread();
    const actionId = await call(chat.id, "connect_app", { app: "aave", why: WHY });
    return { actionId, threadId: chat.id };
  },
  applied: async () => !appsOff().has("aave"),
};

const CASES: readonly Case[] = [AUTONOMY, ROUTINE, CONNECT];

const statusOf = async (id: string) =>
  (await db.select().from(actions).where(eq(actions.id, id)))[0]!;

describe.each(CASES)("$ask", (ask) => {
  it("names its main button for what the tap does", async () => {
    const { actionId } = await ask.propose();
    expect(buttons.get(actionId)).toBe(ask.button);
  });

  it("waits for the owner, and changes nothing until they allow it", async () => {
    const { actionId } = await ask.propose();
    expect(await statusOf(actionId)).toMatchObject({
      status: "awaiting_permission",
      amountUsd: "0.00",
      venue: null,
    });
    expect(await ask.applied()).toBe(false);
  });

  it("applies on Allow, once, with nothing queued to run it", async () => {
    const { actionId } = await ask.propose();
    const allowed = await allowAction(actionId);
    expect(allowed).toMatchObject({ kind: "allowed", action: { status: "done", error: null } });
    expect(await ask.applied()).toBe(true);
    expect(await queued("action")).toEqual([]);
    expect(await allowAction(actionId)).toEqual({ kind: "not_waiting" });
  });

  it("applies nothing on Decline, and tells the thread that asked", async () => {
    const { actionId, threadId } = await ask.propose();
    expect((await declineAction(actionId))?.status).toBe("cancelled");
    expect(await ask.applied()).toBe(false);
    const woken = await queued("turn");
    expect(woken.at(-1)?.data).toMatchObject({ threadId });
  });

  it("is never run by the executor, whatever state it's found in", async () => {
    const { actionId } = await ask.propose();
    await db
      .update(actions)
      .set({ status: "running", phase: "queued" })
      .where(eq(actions.id, actionId));
    expect(await executeAction(actionId)).toMatchObject({ status: "failed" });
    expect(await ask.applied()).toBe(false);
  });
});

describe("saving a routine", () => {
  it("shows the whole routine on the card, files it under the thread that asked, and says when it replaces one", async () => {
    const { actionId, threadId } = await ROUTINE.propose();
    const [row] = await db.select().from(actions).where(eq(actions.id, actionId));
    expect(row).toMatchObject({
      summary: "Save a routine: Check rates",
      threadId,
    });
    expect(row!.lines.at(-1)).toEqual({
      label: "What it says",
      value: "Read every Aave market's rate, and move only for half a point or more.",
    });
    await allowAction(actionId);
    const again = await call(threadId, "save_routine", {
      name: "check-rates",
      description: "Load when moving idle cash.",
      body: "Just ask me.",
    });
    const [replacing] = await db.select().from(actions).where(eq(actions.id, again));
    expect(replacing?.summary).toBe("Replace your routine: Check rates");
    // "Replace Check rates" is too long for a phone's button, so it says what it replaces.
    expect(buttons.get(again)).toBe("Replace routine");
  });

  it("saves only over the routine its card was shown with, never one saved or edited since", async () => {
    const { actionId: older } = await ROUTINE.propose();
    const [row] = await db.select().from(actions).where(eq(actions.id, older));
    const newer = await call(row!.threadId!, "save_routine", {
      name: "check-rates",
      description: "Load when moving idle cash.",
      body: "Move only for a full point.",
    });
    const [shown] = await db.select().from(actions).where(eq(actions.id, newer));
    // Nothing was saved when it was shown, so it says Save, as the older one does.
    expect(shown?.summary).toBe("Save a routine: Check rates");
    expect(await allowAction(newer)).toMatchObject({ action: { status: "done" } });
    const file = join(routinesDir(), "check-rates", "SKILL.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("a full point", "two points"));
    const edited = readFileSync(file, "utf8");

    expect(await allowAction(older)).toMatchObject({
      action: { status: "failed", error: expect.stringContaining("changed since this card") },
    });
    expect(readFileSync(file, "utf8")).toBe(edited);
    const replacing = await call(row!.threadId!, "save_routine", {
      name: "check-rates",
      description: "Load when moving idle cash.",
      body: "Move for any gain.",
    });
    expect(await allowAction(replacing)).toMatchObject({ action: { status: "done" } });
    expect(readFileSync(file, "utf8")).toContain("Move for any gain.");
  });
});

describe("connecting an app", () => {
  const toolNames = async (threadId: string) => {
    const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
    return toolsFor({ thread: thread! }).map((tool) => tool.name);
  };
  const failed = async (threadId: string, input: object) => {
    const outcome = await answer(threadId, "connect_app", input);
    expect(outcome.isError).toBe(true);
    return (outcome.content[0] as { text: string }).text;
  };

  it("says on its card which app it is, why in Auni's words, and what the tap does", async () => {
    const { actionId, threadId } = await CONNECT.propose();
    const outcome = await db.select().from(actions).where(eq(actions.id, actionId));
    expect(outcome[0]).toMatchObject({
      threadId,
      summary: "Turn Aave on",
      input: { app: "aave", why: WHY },
      lines: [
        { label: "Auni says", value: WHY },
        {
          label: "What it changes",
          value:
            "Auni can use Aave again, with its tools and what it knows of it. You can turn it off again under Apps.",
        },
      ],
    });
  });

  it("turns the app back on, gives its tools back, and wakes the thread that offered it", async () => {
    const { actionId, threadId } = await CONNECT.propose();
    expect(await toolNames(threadId)).not.toContain("aave_supply");
    expect(await allowAction(actionId)).toMatchObject({ action: { status: "done" } });
    expect(await toolNames(threadId)).toContain("aave_supply");
    expect(readFileSync(join(home, ".env"), "utf8")).toBe("APPS_OFF=''\n");
    const woken = await queued("turn");
    expect(woken).toHaveLength(1);
    expect(woken[0]!.data).toMatchObject({
      threadId,
      reason: expect.stringContaining("Aave is on again"),
    });
  });

  it("isn't marked done when its switch couldn't be written, and wakes nobody", async () => {
    const { actionId } = await CONNECT.propose();
    // A settings file the writer can't change by one name alone, so it leaves it as it is.
    const text = 'OTHER="one\nAPPS_OFF=aave\nthree"\n';
    writeFileSync(join(home, ".env"), text);
    expect(await allowAction(actionId)).toMatchObject({
      action: {
        status: "failed",
        error: expect.stringContaining("couldn't change its settings file safely"),
      },
    });
    expect(readFileSync(join(home, ".env"), "utf8")).toBe(text);
    expect(await CONNECT.applied()).toBe(false);
    expect(await queued("turn")).toEqual([]);
  });

  it("never asks for a key: an app that is on and lacks one is asked for it by its field", async () => {
    const chat = await insertThread();
    expect(await failed(chat.id, { app: "elfa", why: WHY })).toBe(
      "No card was made: Elfa is on, and needs its Elfa API key, which request_secret asks for in the field keys:elfa.",
    );
    expect(await db.select().from(actions)).toEqual([]);
  });

  it("offers an app once: a second card for it while one waits is refused, in any thread", async () => {
    const { threadId } = await CONNECT.propose();
    const input = { app: "aave", why: WHY };
    expect(await failed(threadId, input)).toMatch(/already waiting for the owner/u);
    expect(await failed((await insertThread()).id, input)).toMatch(/already waiting/u);
    expect(await db.select().from(actions)).toHaveLength(1);
  });

  it("makes no card for an app that isn't there, or that a card can't connect", async () => {
    const chat = await insertThread();
    expect(await failed(chat.id, { app: "nobody", why: WHY })).toMatch(/No app here/u);
    // Nothing is missing of one that is on with all it needs.
    expect(await failed(chat.id, { app: "hyperliquid", why: WHY })).toMatch(/connected already/u);
    // The reason must be one plain sentence: no room to write the owner a second card's worth.
    await expect(
      answer(chat.id, "connect_app", { app: "elfa", why: "x\ny".repeat(8) }),
    ).rejects.toThrow();
    expect(await db.select().from(actions)).toEqual([]);
  });

  it("tells the agent which apps it could offer, and when the owner last said no to one", async () => {
    const voice = { computer: "a shell", models: "a model" };
    expect(appsToOffer(null)).toContain(
      "- elfa (Elfa: Market news, read from what people post). Not connected: it needs its Elfa API key, which request_secret asks for in the field keys:elfa.",
    );
    expect(appsToOffer(null)).not.toContain("- aave");
    expect(await declinedOffers("UTC", null)).toBeNull();

    const { actionId } = await CONNECT.propose();
    expect(await systemPrompt(voice)).toContain(
      "- aave (Aave: Earn on idle cash). Not connected: the owner turned it off, which connect_app turns back on.",
    );
    // Live, 2026-11-14: with Aave off, the AI searched the web for other savings first.
    expect(await systemPrompt(voice)).toContain(
      "When what the owner asks is the work of one they turned off, say first that it is off",
    );
    await declineAction(actionId);
    await db.update(actions).set({ updatedAt: new Date("2026-11-10T09:00:00Z") });
    expect(await declinedOffers("UTC", null)).toBe(
      "On November 10, 2026 the owner declined your card to turn Aave on.",
    );
    // After a no, it may be offered again: when is the agent's to judge, from the date.
    const again = await call((await insertThread()).id, "connect_app", {
      app: "aave",
      why: WHY,
    });
    await allowAction(again);
    // Connected since, the old no is no longer news, and the app leaves the list.
    expect(await declinedOffers("UTC", null)).toBeNull();
    expect(await systemPrompt(voice)).not.toContain("- aave");
  });
});

describe("widening a thread's autonomy", () => {
  it("fails with why once the thread was archived after the card was shown", async () => {
    const { actionId, threadId } = await AUTONOMY.propose();
    await db.update(threads).set({ archivedAt: new Date() }).where(eq(threads.id, threadId));
    const allowed = await allowAction(actionId);
    expect(allowed).toMatchObject({
      kind: "allowed",
      action: { status: "failed", error: "That chat was archived before you allowed this." },
    });
    const [row] = await db.select().from(threads).where(eq(threads.id, threadId));
    expect(row?.actMode).toBe("ask_first");
  });

  it("tightens immediately without putting up a card", async () => {
    const thread = await insertThread({ actMode: "within_limits", budgetUsd: "500" });
    const lowered = await answer(thread.id, "set_thread_autonomy", {
      act_mode: "within_limits",
      budget_usd: 200,
    });
    expect(lowered.isError).toBeUndefined();
    expect(await db.select().from(actions)).toEqual([]);
    const [afterLower] = await db.select().from(threads).where(eq(threads.id, thread.id));
    expect(afterLower).toMatchObject({ actMode: "within_limits", budgetUsd: "200.00" });

    const asked = await answer(thread.id, "set_thread_autonomy", { act_mode: "ask_first" });
    expect(asked.isError).toBeUndefined();
    const [afterAsk] = await db.select().from(threads).where(eq(threads.id, thread.id));
    expect(afterAsk?.actMode).toBe("ask_first");
  });
});
