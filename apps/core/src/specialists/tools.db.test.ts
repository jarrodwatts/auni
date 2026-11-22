import { RETRACTED } from "@auni/shared";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildMcpServer } from "../agent/mcp.ts";
import { db } from "../db/client.ts";
import { actions, fills, specialists, threads } from "../db/schema.ts";
import { insertAction, insertSpecialist, insertThread, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import { stubRecipe } from "../test/recipe.ts";
import { declineProposal } from "../money/decide.ts";
import type { PreparedLeg } from "../money/actions.ts";
import { specialistTools } from "./tools.ts";
import { undoSpecialistUpdate } from "./updates.ts";
import type { Paying } from "../money/pay-with-holdings.ts";
import type { Portfolio } from "../money/portfolio.ts";
import { convertToCash } from "../money/recipes/convert.ts";

// A live read finds the specialist worth $12; a screen's estimate, minutes old, $1.
const worth = vi.hoisted(() => ({ specialistId: "" }));
vi.mock("../money/portfolio.ts", async (importOriginal) => {
  const valued = (usdValue: string): Partial<Portfolio> => ({
    specialists: [
      {
        id: worth.specialistId,
        purpose: "",
        status: "active",
        usdValue,
        holdings: [],
        whole: true,
      },
    ],
  });
  return {
    ...(await importOriginal<object>()),
    readPortfolio: async () => valued("12.00"),
    portfolioNow: async () => valued("1.00"),
  };
});

// A card's picks priced without a venue, an empty wallet, and what its holdings pay with; each
// left unset reads for real.
const planned = vi.hoisted(() => ({
  picks: null as PreparedLeg[] | null,
  paying: null as Paying[] | null,
}));
vi.mock("../money/actions.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../money/actions.ts")>();
  return {
    ...actual,
    prepareLegs: async (...args: Parameters<typeof actual.prepareLegs>) =>
      planned.picks ? { prepared: [...planned.picks], problems: [] } : actual.prepareLegs(...args),
  };
});
vi.mock("../money/funding.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../money/funding.ts")>();
  return {
    ...actual,
    walletCash: async (...args: Parameters<typeof actual.walletCash>) =>
      planned.paying
        ? { spendable: new Map([["base", 0n]]), sendable: new Map([["base", 0n]]) }
        : actual.walletCash(...args),
  };
});
vi.mock("../money/pay-with-holdings.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../money/pay-with-holdings.ts")>();
  return {
    ...actual,
    payingHoldings: async (...args: Parameters<typeof actual.payingHoldings>) =>
      planned.paying ?? actual.payingHoldings(...args),
  };
});

// The specialists whose watches were deleted on retiring.
const retiredWatches = vi.hoisted(() => [] as string[]);
vi.mock("../automations/automations.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  deleteSpecialistAutomations: async (id: string) => void retiredWatches.push(id),
}));

beforeEach(async () => {
  planned.picks = null;
  planned.paying = null;
  retiredWatches.length = 0;
  await wipe(fills, specialists, threads, actions);
});

/** Calls one specialist tool as the agent would, in a new chat or the given thread. */
async function call(
  name: string,
  input: Record<string, unknown>,
  thread?: { id: string; specialistId: string | null },
) {
  const { id: threadId, specialistId } = thread ?? (await insertThread());
  const tool = specialistTools({ threadId, specialistId }).find(
    (candidate) => candidate.name === name,
  );
  const outcome = await tool!.handler(input);
  return {
    failed: outcome.isError === true,
    text: (outcome.content[0] as { text: string }).text,
    card: (outcome.structuredContent as { card?: Record<string, unknown> } | undefined)?.card,
  };
}

/** What an ask card's Allow would set: the input of the row it waits on. */
async function asked(card: Record<string, unknown> | undefined) {
  expect(card).toMatchObject({ kind: "ask", ask: "update_specialist" });
  const [row] = await db
    .select()
    .from(actions)
    .where(eq(actions.id, String(card?.actionReference)));
  expect(row?.status).toBe("awaiting_permission");
  return row?.input;
}

const rules = async (id: string) => {
  const [row] = await db.select().from(specialists).where(eq(specialists.id, id));
  return { actMode: row?.actMode, potUsd: row?.potUsd, name: row?.name };
};

describe("acting on its own takes the owner's tap", () => {
  it("asks on a card rather than letting an ask-first one act on its own", async () => {
    const specialist = await insertSpecialist({ potUsd: "100" });
    const { card } = await call("update_specialist", {
      specialist_id: specialist.id,
      act_mode: "within_limits",
      pot_usd: 10_000_000,
    });
    expect(await rules(specialist.id)).toMatchObject({ actMode: "ask_first", potUsd: "100.00" });
    expect(await asked(card)).toMatchObject({ act_mode: "within_limits", pot_usd: "10000000.00" });
  });

  it("asks on a card rather than raising the pot of one that acts on its own", async () => {
    const specialist = await insertSpecialist({
      potUsd: "100",
      actMode: "within_limits",
    });
    const { card } = await call("update_specialist", {
      specialist_id: specialist.id,
      pot_usd: 10_000_000,
    });
    expect(await rules(specialist.id)).toMatchObject({ potUsd: "100.00" });
    expect(await asked(card)).toMatchObject({ act_mode: "within_limits", pot_usd: "10000000.00" });
  });

  it("refuses the whole call when other changes come with the ask", async () => {
    const specialist = await insertSpecialist();
    const outcome = await call("update_specialist", {
      specialist_id: specialist.id,
      act_mode: "within_limits",
      name: "Renamed",
    });
    expect(outcome).toMatchObject({ failed: true, card: undefined });
    expect(await rules(specialist.id)).toMatchObject({ actMode: "ask_first", name: "AI" });
  });

  it("still applies what runs no more without a tap straight away", async () => {
    const asking = await insertSpecialist({ potUsd: "100" });
    await call("update_specialist", { specialist_id: asking.id, pot_usd: 900 });
    expect(await rules(asking.id)).toMatchObject({ actMode: "ask_first", potUsd: "900.00" });

    const acting = await insertSpecialist({ potUsd: "500", actMode: "within_limits" });
    const lowered = await call("update_specialist", {
      specialist_id: acting.id,
      pot_usd: 200,
    });
    expect(lowered.card).toMatchObject({ kind: "specialist_update" });
    expect(await rules(acting.id)).toMatchObject({ actMode: "within_limits", potUsd: "200.00" });

    await call("update_specialist", { specialist_id: acting.id, act_mode: "ask_first" });
    expect(await rules(acting.id)).toMatchObject({ actMode: "ask_first" });
  });
});

describe("undo never widens what runs", () => {
  /** Acting on its own with $100, switched to ask first: the receipt's update. */
  async function askedFirst() {
    const specialist = await insertSpecialist({
      potUsd: "100",
      actMode: "within_limits",
    });
    const { card } = await call("update_specialist", {
      specialist_id: specialist.id,
      act_mode: "ask_first",
    });
    return { specialist, updateId: String(card?.updateId) };
  }

  it("lets it act on its own again with the pot it had", async () => {
    const { specialist, updateId } = await askedFirst();
    const outcome = await undoSpecialistUpdate(specialist.id, updateId);
    expect(outcome.status).toBe("undone");
    expect(await rules(specialist.id)).toMatchObject({
      actMode: "within_limits",
      potUsd: "100.00",
    });
  });

  it("is refused once the pot has grown since", async () => {
    const { specialist, updateId } = await askedFirst();
    await call("update_specialist", { specialist_id: specialist.id, pot_usd: 1_000_000 });
    const outcome = await undoSpecialistUpdate(specialist.id, updateId);
    expect(outcome.status).toBe("widens");
    expect(await rules(specialist.id)).toMatchObject({
      actMode: "ask_first",
      potUsd: "1000000.00",
    });
  });
});

describe("get_specialist", () => {
  it("values it by a live read, not a screen's estimate", async () => {
    const specialist = await insertSpecialist();
    worth.specialistId = specialist.id;
    const { id: threadId } = await insertThread();
    const tool = specialistTools({ threadId, specialistId: specialist.id }).find(
      (candidate) => candidate.name === "get_specialist",
    );
    const outcome = await tool!.handler({});
    const text = (outcome.content[0] as { text: string }).text;
    // A token of theirs is named by its maker, so all of it is read fenced as data.
    expect(outcome.structuredContent).toBeUndefined();
    const fence = /^A token of theirs .*\n<specialist>(.*)<\/specialist>$/su.exec(text);
    expect(JSON.parse(fence![1]!)).toMatchObject({ valueUsd: "12.00" });
  });

  it("reads its kind, notes and report", async () => {
    const specialist = await insertSpecialist({ notes: "Watching the June trial." });
    worth.specialistId = specialist.id;
    const { text } = await call("get_specialist", { specialist_id: specialist.id });
    const fence = /<specialist>(.*)<\/specialist>/su.exec(text);
    expect(JSON.parse(fence![1]!)).toMatchObject({
      kind: "take",
      notes: "Watching the June trial.",
      report: null,
    });
  });
});

describe("notes and retiring", () => {
  it("rewrites its notes with no receipt", async () => {
    const specialist = await insertSpecialist();
    const outcome = await call("update_specialist", {
      specialist_id: specialist.id,
      notes: "Add on a dip below $40.",
    });
    expect(outcome).toMatchObject({ failed: false, card: undefined });
    const [row] = await db.select().from(specialists).where(eq(specialists.id, specialist.id));
    expect(row?.notes).toBe("Add on a dip below $40.");
  });

  it("retires one with its report, declining what waits and stopping its watches", async () => {
    const specialist = await insertSpecialist();
    const waiting = await insertAction({
      specialistId: specialist.id,
      status: "awaiting_permission",
    });
    const outcome = await call("update_specialist", {
      specialist_id: specialist.id,
      retired: true,
      report: "Up 12% over three months; sold it all to cash.",
    });
    expect(outcome.failed).toBe(false);
    const [row] = await db.select().from(specialists).where(eq(specialists.id, specialist.id));
    expect(row).toMatchObject({
      status: "retired",
      report: "Up 12% over three months; sold it all to cash.",
    });
    expect(row?.retiredAt).toBeInstanceOf(Date);
    const [takenBack] = await db.select().from(actions).where(eq(actions.id, waiting.id));
    expect(takenBack).toMatchObject({ status: "retracted", error: RETRACTED.retired });
    expect(retiredWatches).toEqual([specialist.id]);
    const again = await call("update_specialist", {
      specialist_id: specialist.id,
      notes: "x",
    });
    expect(again.failed).toBe(true);
  });

  it("won't retire without a report, or take a report without retiring", async () => {
    const specialist = await insertSpecialist();
    for (const input of [{ retired: true }, { report: "Done." }]) {
      const outcome = await call("update_specialist", {
        specialist_id: specialist.id,
        ...input,
      });
      expect(outcome.failed).toBe(true);
    }
    const [row] = await db.select().from(specialists).where(eq(specialists.id, specialist.id));
    expect(row?.status).toBe("active");
  });
});

// A real Claude Code, asked to close a take, sent `"retired": "true"` twice; the MCP server refused
// both before update_specialist ran, and the take stayed open.
describe("retiring over the MCP server", () => {
  it("retires one when the agent sends retired as text", async () => {
    const specialist = await insertSpecialist();
    const { id: threadId } = await insertThread();
    const server = buildMcpServer(specialistTools({ threadId, specialistId: null }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(clientSide);

    const outcome = await client.callTool({
      name: "update_specialist",
      arguments: {
        specialist_id: specialist.id,
        retired: "true",
        report: "Sold the rest to cash; closed as asked.",
      },
    });

    expect(outcome.isError, JSON.stringify(outcome.content)).toBeFalsy();
    const [row] = await db.select().from(specialists).where(eq(specialists.id, specialist.id));
    expect(row).toMatchObject({
      status: "retired",
      report: "Sold the rest to cash; closed as asked.",
    });
    expect(retiredWatches).toEqual([specialist.id]);
  });
});

describe("propose_specialist_portfolio", () => {
  const buy = stubRecipe();
  const pick = (usd: string): PreparedLeg => ({
    recipe: buy,
    input: { usd },
    preview: {
      summary: `Buy $${usd} of Nvidia`,
      amountUsd: usd,
      effect: { gives: [{ text: `$${usd} of USDC` }], gets: [{ text: "NVDAx" }], grants: [] },
    },
  });
  const conversion: PreparedLeg = {
    recipe: convertToCash,
    input: { chain: "base", token: "native", amount: "0.01" },
    preview: {
      summary: "Convert 0.01 ETH on Base to about $30.00 of USDC",
      amountUsd: "29.50",
      effect: { gives: [{ text: "0.01 ETH" }], gets: [{ text: "USDC" }], grants: [] },
      details: { sell: "0.01 ETH", returnsUsd: "30.00", feeUsd: "0.10" },
    },
  };
  const leg = (name: string) => ({ tool: "stock_trade", input: {}, name, why: "Makes the chips" });

  // The conversion is a move on the card, past the picks the agent named, never a pick of its own.
  it("shows what pays for a short card among its moves, apart from the picks", async () => {
    const specialist = await insertSpecialist();
    const thread = await insertThread({ specialistId: specialist.id });
    planned.picks = [pick("20"), pick("10")];
    planned.paying = [{ conversion, bridge: null }];
    const { failed, card } = await call(
      "propose_specialist_portfolio",
      { legs: [leg("Nvidia"), leg("AMD")] },
      thread,
    );
    expect(failed).toBe(false);
    expect((card!.legs as { name: string }[]).map(({ name }) => name)).toEqual(["Nvidia", "AMD"]);
    expect(card!.moves).toMatchObject([{ name: "Convert 0.01 ETH on Base to USDC" }]);
  });

  // A first take: one card, its picks and their money, the take started behind it.
  it("starts a new take behind its first card, asking first, from Auni's chat", async () => {
    planned.picks = [pick("30"), pick("20")];
    const take = { purpose: "Peptides go mainstream by 2028", name: "Peptides", pot_usd: 50 };
    const { failed, card } = await call("propose_specialist_portfolio", {
      take,
      legs: [leg("Eli Lilly"), leg("Novo Nordisk")],
    });
    expect(failed).toBe(false);
    const [started] = await db.select().from(specialists);
    expect(started).toMatchObject({
      kind: "take",
      name: "Peptides",
      purpose: take.purpose,
      potUsd: "50.00",
      actMode: "ask_first",
      status: "active",
    });
    expect(card).toMatchObject({ specialistId: started!.id, specialistName: take.purpose });
    // Nothing runs on its own: every pick waits for the owner's tap on the card.
    const rows = await db.select().from(actions).where(eq(actions.specialistId, started!.id));
    expect(rows.map(({ status }) => status)).toEqual([
      "awaiting_permission",
      "awaiting_permission",
    ]);
  });

  // Review, 2026-11-17: a take whose first card was declined stayed active with its $50 pot.
  it("retires a take with its first card when the owner declines it, and says so", async () => {
    planned.picks = [pick("30"), pick("20")];
    const take = { purpose: "Peptides go mainstream", name: "Peptides", pot_usd: 50 };
    const { card } = await call("propose_specialist_portfolio", {
      take,
      legs: [leg("Eli Lilly"), leg("Novo Nordisk")],
    });
    await declineProposal(String(card!.proposalId));
    expect(await db.select().from(specialists)).toMatchObject([
      { name: "Peptides", status: "retired" },
    ]);
    expect(JSON.stringify(await queued())).toContain(
      "The take Peptides had nothing else, so it is retired with it.",
    );
  });

  it("keeps a take that had more than the card the owner declined", async () => {
    const specialist = await insertSpecialist();
    await insertAction({ specialistId: specialist.id, status: "done" });
    const thread = await insertThread({ specialistId: specialist.id });
    planned.picks = [pick("30")];
    const { card } = await call("propose_specialist_portfolio", { legs: [leg("Nvidia")] }, thread);
    await declineProposal(String(card!.proposalId));
    expect((await rules(specialist.id)).name).toBe("AI");
    const [row] = await db.select().from(specialists);
    expect(row!.status).toBe("active");
  });

  it("makes the take only with its first card's moves, never without them", async () => {
    planned.picks = [pick("30")];
    const take = { purpose: "Peptides go mainstream", name: "Peptides", pot_usd: 50 };
    await expect(
      call("propose_specialist_portfolio", { take, legs: [leg("Eli Lilly")], replaces: ["nope"] }),
    ).rejects.toThrow("no card waiting in this conversation");
    expect(await db.select().from(specialists)).toEqual([]);
  });

  it("starts no take when its picks don't pass, or with a specialist named too", async () => {
    const take = { purpose: "Peptides go mainstream", name: "Peptides", pot_usd: 50 };
    const refused = await call("propose_specialist_portfolio", {
      take,
      legs: [{ tool: "no_such_tool", input: {}, name: "Nothing", why: "Nothing" }],
    });
    expect(refused.failed).toBe(true);
    const specialist = await insertSpecialist();
    planned.picks = [pick("30")];
    const both = await call("propose_specialist_portfolio", {
      take,
      specialist_id: specialist.id,
      legs: [leg("Eli Lilly")],
    });
    expect(both.failed).toBe(true);
    expect(await db.select().from(specialists)).toHaveLength(1);
  });

  it("offers a new take only in Auni's own chat", async () => {
    const specialist = await insertSpecialist();
    const inside = specialistTools({ threadId: "t", specialistId: specialist.id }).find(
      ({ name }) => name === "propose_specialist_portfolio",
    );
    expect(inside!.inputSchema).not.toHaveProperty("take");
  });

  // Live, 2026-11-14: "give crypto majors 2 dollars more" got a card whose button said "Start with $2".
  it("marks a card for a specialist that has bought before as adding to it", async () => {
    const specialist = await insertSpecialist();
    const thread = await insertThread({ specialistId: specialist.id });
    planned.picks = [pick("2")];
    const first = await call("propose_specialist_portfolio", { legs: [leg("Nvidia")] }, thread);
    expect(first.card!.adds).toBeUndefined();

    const bought = await insertAction({ threadId: thread.id, specialistId: specialist.id });
    await db.insert(fills).values({
      actionId: bought.id,
      specialistId: specialist.id,
      instrument: "0xNVDA",
      chain: "monad",
      side: "buy",
      quantity: "0.01",
      usdValue: "2.00",
    });
    planned.picks = [pick("2")];
    const more = await call("propose_specialist_portfolio", { legs: [leg("Nvidia")] }, thread);
    expect(more.card!.adds).toBe(true);
  });
});
