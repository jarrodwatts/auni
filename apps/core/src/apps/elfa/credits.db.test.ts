import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { toolsFor } from "../../agent/mcp.ts";
import entities from "./fixtures/hype-entities.json";
import week from "./fixtures/hype-events-7d.json";
import { appTroublesNow, troubleWords } from "../../app-troubles.ts";
import { appTroubles, threads } from "../../db/schema.ts";
import { insertThread, wipe } from "../../test/db.ts";

beforeEach(async () => {
  await wipe(appTroubles, threads);
  process.env.ELFA_AUTO_API_KEY = "elfa-test";
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.ELFA_AUTO_API_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Elfa as it answers a key with no credits left: 402 to everything. */
const credits = { left: false };
function elfa() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (!credits.left)
        return Response.json({ code: "ERR_INSUFFICIENT_CREDITS" }, { status: 402 });
      // Elfa's real answers for HYPE (apps/elfa/fixtures).
      return Response.json(new URL(input).pathname === "/v3/entities" ? entities : week);
    }),
  );
}

const text = (answer: CallToolResult) =>
  answer.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");

describe("an app's lookup that finds its key out of credits", () => {
  it("tells the agent to say so to the owner, and Elfa's sheet says it until Elfa answers again", async () => {
    // The owner tapped Elfa's own chip; market_news answered "Elfa is out of credits" twice, and
    // the agent searched the web instead without a word about Elfa (2026-11-13).
    credits.left = false;
    elfa();
    const tools = toolsFor({ thread: await insertThread() });
    const news = tools.find(({ name }) => name === "market_news")!;
    const answer = (await news.handler({ subject: "HYPE" } as never)) as CallToolResult;
    expect(answer.isError).toBe(true);
    expect(text(answer)).toBe(
      "Elfa is out of credits, so it answered nothing. Tell the owner in your reply, plainly and before anything you find elsewhere: Elfa can't be used until its account is topped up, which its sheet in Apps says too. If you answer from other sources instead, say which.",
    );
    const [trouble] = await appTroublesNow();
    expect(trouble).toMatchObject({ app: "elfa", kind: "credits", times: 1 });
    expect(troubleWords(trouble!, "Elfa", () => "3:40 PM")).toEqual({
      short: "Out of credits",
      says: "Elfa said its account is out of credits when Auni last asked it, at 3:40 PM. Auni can't use Elfa until the account is topped up, and starts again by itself once it is.",
    });

    credits.left = true;
    expect(((await news.handler({ subject: "HYPE" } as never)) as CallToolResult).isError).toBe(
      undefined,
    );
    expect(await appTroublesNow()).toEqual([]);
  });

  it("notes nothing for any other refusal, which is the lookup's own", async () => {
    credits.left = true;
    elfa();
    vi.mocked(fetch).mockImplementation(async () => new Response("bad request", { status: 400 }));
    const tools = toolsFor({ thread: await insertThread() });
    const news = tools.find(({ name }) => name === "market_news")!;
    expect(((await news.handler({ subject: "BTC" } as never)) as CallToolResult).isError).toBe(
      true,
    );
    expect(await appTroublesNow()).toEqual([]);
  });
});
