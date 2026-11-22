import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { declinedOffers } from "../connect.ts";
import { db } from "../db/client.ts";
import { actions, jobs, messages, threads } from "../db/schema.ts";
import { allowAction, declineAction } from "../money/decide.ts";
import { privateRouter } from "../routes/private.ts";
import { insertThread, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import { serve } from "../test/serve.ts";
import { toolsFor } from "./mcp.ts";

// request_secret: the agent names a field core declares, and nothing else; core words its card;
// the owner's browser sends the value straight to core's private field, which saves it and
// settles the card; and all the agent ever hears is that it was saved, or that they said no.

// What the owner pastes, which must show up nowhere the agent, a log or a thread could read.
const API_KEY = "elfa_live_9f3c2b7a41d84e06b5aa";
const WHY = "I could show you the week's stories pinned to the price.";

const url = serve(express().use("/private", privateRouter));
const paste = (field: string, values: Record<string, string>) =>
  fetch(url(`/private/${encodeURIComponent(field)}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ values }),
  });

let home: string;
const realHome = process.env.AUNI_HOME;
let logged = "";
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "auni-secret-"));
  process.env.AUNI_HOME = home;
  delete process.env.ELFA_AUTO_API_KEY;
  await wipe(threads, actions, jobs, messages);
  logged = "";
  for (const level of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, level).mockImplementation((...said: unknown[]) => {
      logged += `${said.map(String).join(" ")}\n`;
    });
  // Elfa takes the key, at the one call its key is tried with.
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
    String(input instanceof Request ? input.url : input).startsWith("https://api.elfa.ai/")
      ? Response.json({ plan: "free" })
      : real(input, init),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
  process.env.AUNI_HOME = realHome;
  delete process.env.ELFA_AUTO_API_KEY;
  expect(logged).not.toContain(API_KEY);
});

async function ask(threadId: string, input: object) {
  const [thread] = await db.select().from(threads).where(eq(threads.id, threadId));
  const tool = toolsFor({ thread: thread! }).find(({ name }) => name === "request_secret");
  return tool!.handler(input as never);
}

/** Everything the agent could ever read of a thread: its rows, its wakes, and every action. */
async function whatTheAgentReads(threadId: string): Promise<string> {
  return JSON.stringify([
    await db.select().from(messages).where(eq(messages.threadId, threadId)),
    await queued(),
    await db.select().from(actions),
  ]);
}

describe("request_secret", () => {
  it("asks only for a field core takes, and says which those are", async () => {
    const chat = await insertThread();
    for (const field of [
      "keys:nobody",
      "setting:elfa:apiKey",
      "RPC_URL_BASE",
      "WALLET",
      "keys:telegram/../core",
    ]) {
      const refused = await ask(chat.id, { field, why: WHY });
      expect(refused.isError, field).toBe(true);
      expect((refused.content[0] as { text: string }).text).toMatch(
        /No card was made.*keys:elfa/su,
      );
    }
    expect(await db.select().from(actions)).toEqual([]);
  });

  it("words its card itself, carrying only the agent's sentence on why", async () => {
    const chat = await insertThread();
    const asked = await ask(chat.id, { field: "keys:elfa", why: WHY });
    expect(asked.structuredContent).toMatchObject({
      card: {
        kind: "ask",
        ask: "request_secret",
        field: "keys:elfa",
        app: "elfa",
        summary: "Elfa API key",
        action: "Save",
        lines: [{ label: "Auni says", value: WHY }],
      },
    });
    // One waiting card for a field at a time.
    expect((await ask(chat.id, { field: "keys:elfa", why: WHY })).isError).toBe(true);
  });

  it("is allowed by the secret saved in its field, and the agent hears that alone", async () => {
    const chat = await insertThread();
    const asked = await ask(chat.id, { field: "keys:elfa", why: WHY });
    const id = (asked.structuredContent as { card: { actionReference: string } }).card
      .actionReference;
    // A tap can't say it was given.
    expect(await allowAction(id)).toEqual({ kind: "in_its_field" });
    expect(await queued("turn")).toEqual([]);

    expect((await paste("keys:elfa", { apiKey: API_KEY })).status).toBe(200);
    expect(readFileSync(join(home, ".env"), "utf8")).toContain(API_KEY);
    const [row] = await db.select().from(actions).where(eq(actions.id, id));
    expect(row!.status).toBe("done");
    const woken = await queued("turn");
    expect(woken).toHaveLength(1);
    expect(woken[0]!.data).toMatchObject({
      threadId: chat.id,
      reason: "The owner saved their Elfa API key, which your card asked for.",
    });
    expect(JSON.stringify(asked)).not.toContain(API_KEY);
    expect(await whatTheAgentReads(chat.id)).not.toContain(API_KEY);
  });

  it("tells the agent of a no, and when, while the key is still missing", async () => {
    const chat = await insertThread();
    const asked = await ask(chat.id, { field: "keys:elfa", why: WHY });
    const id = (asked.structuredContent as { card: { actionReference: string } }).card
      .actionReference;
    await declineAction(id);
    expect((await queued("turn"))[0]!.data).toMatchObject({
      reason: expect.stringContaining("The owner declined action"),
    });
    await db.update(actions).set({ updatedAt: new Date("2026-11-10T09:00:00Z") });
    expect(await declinedOffers("UTC", null)).toBe(
      "On November 10, 2026 the owner declined your card asking for their Elfa API key.",
    );
    expect((await paste("keys:elfa", { apiKey: API_KEY })).status).toBe(200);
    expect(await declinedOffers("UTC", null)).toBeNull();
  });
});
