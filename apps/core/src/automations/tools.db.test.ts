import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuniTool } from "../agent/tool.ts";
import { db } from "../db/client.ts";
import { automations, threads } from "../db/schema.ts";
import { insertThread, wipe } from "../test/db.ts";
import { automationTools } from "./tools.ts";

beforeEach(() => wipe(threads, automations));
afterEach(() => {
  process.env.ELFA_AUTO_API_KEY = "";
  vi.unstubAllGlobals();
});

/** Hyperliquid's mid prices, for the prices source's check of a market's name. */
function hyperliquidLists() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string, init?: RequestInit) => {
      const { dex } = JSON.parse(String(init?.body)) as { dex?: string };
      return Response.json(dex === "xyz" ? { "xyz:NVDA": "196.8" } : { BTC: "79600.5" });
    }),
  );
}

async function tools() {
  const thread = await insertThread();
  const [watch, list] = automationTools({ threadId: thread.id, specialistId: null });
  const call = (tool: AuniTool, input: Record<string, unknown>) =>
    tool.handler(input as never) as Promise<CallToolResult>;
  return { watch: watch!, list: list!, call, thread };
}

const text = (result: CallToolResult) =>
  result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

describe("the watch tool", () => {
  it("lists each source it can use now, and only those, and gives each one's guide when asked", async () => {
    const { watch, call } = await tools();
    expect(watch.description).toContain('- source "prices" (Prices): The price of anything');
    expect(watch.description).not.toContain('source "elfa"');
    const guide = text(await call(watch, { action: "guide", source: "prices" }));
    expect(guide).toContain('## source "prices" (Prices)');
    expect(guide).toContain('{"market":"BTC","crosses":"below","price":60000}');
    expect(guide).toContain('"crosses":{"type":"string","enum":["above","below"]}');

    process.env.ELFA_AUTO_API_KEY = "elfa-test";
    expect((await tools()).watch.description).toContain('- source "elfa" (Elfa): News, posts on X');
  });

  it("keeps its description within what a brain shows of it, with every source set up", async () => {
    process.env.ELFA_AUTO_API_KEY = "elfa-test";
    const { watch } = await tools();
    // Claude Code 2.1.321 cuts an MCP tool's description at 4,096 characters, which cut the
    // prices source off a specialist's watch tool when every source's whole guide was in it.
    expect(watch.description.length).toBeLessThanOrEqual(4_096);
  });

  it("refuses the shapes a specialist guessed with the guide that writes it right", async () => {
    hyperliquidLists();
    const { watch, call } = await tools();
    const create = (condition: unknown) =>
      call(watch, {
        action: "create",
        source: "prices",
        condition,
        description: "Nvidia falls below $180",
        note: "They want more under $180.",
      });
    // The two shapes a specialist tried on 2026-11-13, which its cut description never showed it.
    for (const guessed of [
      { asset: "xyz:NVDA", metric: "price", operator: "<", value: 180 },
      { market: "xyz:NVDA", operator: "<", value: 180 },
    ]) {
      const refused = await create(guessed);
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain("Prices can't read that condition");
      expect(text(refused)).toContain('{"market":"BTC","crosses":"below","price":60000}');
    }
    // Written as the refusal says, it is taken at once.
    expect((await create({ market: "xyz:NVDA", crosses: "below", price: 180 })).isError).toBe(
      undefined,
    );
  });

  it("sets up, changes and deletes a watch, in the source's own condition", async () => {
    hyperliquidLists();
    const { watch, list, call, thread } = await tools();
    const created = await call(watch, {
      action: "create",
      source: "prices",
      condition: { market: "xyz:NVDA", crosses: "below", price: 180 },
      description: "Nvidia falls below $180",
      note: "They want to buy more under $180.",
      repeat: "4h",
      expires_in: "7d",
    });
    expect(created.isError).toBeUndefined();
    const [row] = await db.select().from(automations);
    expect(row).toMatchObject({
      source: "prices",
      threadId: thread.id,
      condition: { market: "xyz:NVDA", crosses: "below", price: 180 },
      repeat: "4h",
      status: "active",
      sourceRef: null,
    });
    expect(row!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    const changed = await call(watch, {
      action: "edit",
      watch_id: row!.id,
      condition: { market: "xyz:NVDA", crosses: "below", price: 175 },
      repeat: "once",
      expires_in: "never",
    });
    expect(text(changed)).toContain("Changed: Nvidia falls below $180");
    const [edited] = await db.select().from(automations);
    expect(edited).toMatchObject({ condition: { price: 175 }, repeat: null, expiresAt: null });

    const listed = (await call(list, {})).structuredContent as { automations: unknown[] };
    expect(listed.automations).toHaveLength(1);
    await call(watch, { action: "delete", watch_id: row!.id });
    expect((await db.select().from(automations))[0]?.status).toBe("deleted");
  });

  it("won't change a watch that has ended, and never says a paused one is watching", async () => {
    hyperliquidLists();
    const { watch, call } = await tools();
    await call(watch, {
      action: "create",
      source: "prices",
      condition: { market: "BTC", crosses: "below", price: 60_000 },
      description: "Bitcoin falls below $60,000",
      note: "They want to buy under $60,000.",
    });
    const [row] = await db.select().from(automations);
    const edit = () =>
      call(watch, {
        action: "edit",
        watch_id: row!.id,
        condition: { market: "BTC", crosses: "below", price: 55_000 },
      });

    // It fired once, so it has ended: the agent is told to set up a new one.
    await db.update(automations).set({ status: "triggered" });
    const ended = await edit();
    expect(ended.isError).toBe(true);
    expect(text(ended)).toContain("has ended (triggered); set up a new one");
    expect((await db.select().from(automations))[0]).toMatchObject({
      status: "triggered",
      condition: { price: 60_000 },
    });

    await db.update(automations).set({ status: "paused" });
    const paused = await edit();
    expect(text(paused)).toContain("It stays paused");
    expect(text(paused)).not.toContain("woken");
    expect((await db.select().from(automations))[0]).toMatchObject({
      status: "paused",
      condition: { price: 55_000 },
    });
  });

  it("hands back why a source won't take a condition, so the agent can reshape it", async () => {
    hyperliquidLists();
    const { watch, call } = await tools();
    const create = (condition: unknown) =>
      call(watch, {
        action: "create",
        source: "prices",
        condition,
        description: "Nvidia falls below $180",
        note: "They want more under $180.",
      });

    const unknown = await create({ market: "NVDA", crosses: "below", price: 180 });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain("Hyperliquid lists no market named NVDA");
    const malformed = await create({ market: "BTC", crosses: "sideways", price: 1 });
    expect(text(malformed)).toContain("Prices can't read that condition");
    expect(await db.select().from(automations)).toHaveLength(0);
  });
});
