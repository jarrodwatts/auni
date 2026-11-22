import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { networkFacts } from "./prompt.ts";
import { fillSkill, loadSkillTool } from "./skills.ts";

describe("fillSkill", () => {
  it("names the networks as the prompt does, read from the registry", async () => {
    const facts = await networkFacts();
    expect(fillSkill("Add money on {{DEPOSIT_NETWORKS}}.", facts)).toBe(
      `Add money on ${facts.DEPOSIT_NETWORKS}.`,
    );
  });

  it("refuses a placeholder with no value rather than handing the agent the braces", () => {
    expect(() => fillSkill("on {{CASH_CHAINS}}", {}, "how-auni-works")).toThrow(
      "how-auni-works names {{CASH_CHAINS}}, which has no value.",
    );
  });
});

describe("load_skill", () => {
  const tool = loadSkillTool();
  const names = ["evm-transactions", "how-auni-works", "picking-a-venue", "solana-transactions"];

  it("lists every skill with when to load it", () => {
    for (const name of names) expect(tool.description).toContain(`- ${name}: Load `);
  });

  it("returns each skill filled in, and no skill it doesn't have", async () => {
    for (const name of names) {
      const { content } = await tool.handler({ name });
      const text = content.map((part) => (part.type === "text" ? part.text : "")).join("");
      expect(text).toContain(`name: ${name}`);
      expect(text).not.toMatch(/\{\{\w+\}\}/u);
    }
    expect(z.object(tool.inputSchema).safeParse({ name: "unknown" }).success).toBe(false);
  });
});

describe("an app's own skill", () => {
  afterEach(() => {
    delete process.env.APPS_OFF;
  });

  const text = async (tool: ReturnType<typeof loadSkillTool>, name: string) =>
    (await tool.handler({ name })).content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");

  it("is listed under the app's id while the app is on, and named in picking-a-venue", async () => {
    const tool = loadSkillTool();
    for (const id of ["hyperliquid", "polymarket", "aave", "across"])
      expect(tool.description).toContain(`- ${id}: Load `);
    expect(await text(tool, "hyperliquid")).toContain("name: hyperliquid");
    const venues = await text(tool, "picking-a-venue");
    expect(venues).toContain("**Polymarket** (the polymarket skill)");
    expect(venues).toContain("`polymarket_order`, `polymarket_withdraw`, `polymarket_markets`.");
    expect(venues).not.toContain("polymarket_payout");
  });

  it("leaves the list, and picking-a-venue, when the owner switches the app off", async () => {
    process.env.APPS_OFF = "polymarket";
    const tool = loadSkillTool();
    expect(tool.description).not.toContain("- polymarket:");
    expect(z.object(tool.inputSchema).safeParse({ name: "polymarket" }).success).toBe(false);
    expect(await text(tool, "picking-a-venue")).not.toContain("Polymarket");
    expect(tool.description).toContain("- hyperliquid: Load ");
    // Auni's own skills speak only of the apps that are on.
    expect(await text(tool, "how-auni-works")).not.toContain("Polymarket");
  });

  it("names apps in Auni's own skills only as the registry fills them in", async () => {
    const tool = loadSkillTool();
    const works = await text(tool, "how-auni-works");
    expect(works.replace(/\s+/gu, " ")).toContain(
      "the cash they keep at an app (Aave, Hyperliquid and Polymarket)",
    );
    const evm = await text(tool, "evm-transactions");
    expect(evm).toContain("`bridge_usdc` with `output_token`");
    expect(evm).toContain("the defillama skill and the dexscreener skill");
    expect(await text(tool, "solana-transactions")).toContain("check: the jupiter skill.");
  });
});
