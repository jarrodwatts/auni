import { feedbackCardSchema, feedbackPost, feedbackWireSchema } from "@auni/shared";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendFeedbackTool } from "./agent/feedback-tool.ts";
import { actions, threads } from "./db/schema.ts";
import { appRequest, bugReport } from "./feedback.ts";
import { feedbackRouter } from "./routes/feedback.ts";
import { insertAction, insertThread, wipe } from "./test/db.ts";
import { serve } from "./test/serve.ts";

// What a feedback card carries, built from rows as core records them: everything a part says
// comes from an allow-list of their fields, and nothing of the owner's is in any of it.

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOLANA_OWNER = "JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n";
vi.mock(import("./money/wallets.ts"), async (original) => ({
  ...(await original()),
  walletAddresses: async () => ({ evm: OWNER, solana: SOLANA_OWNER }),
}));

const LIDO = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
const STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
const HASH = `0x${"7c".repeat(32)}`;
/** A stake the agent built for Lido, as it is recorded once done: its calldata names the owner. */
const stake = (threadId: string, fields: Partial<typeof actions.$inferInsert> = {}) =>
  insertAction({
    threadId,
    status: "done",
    tool: "send_evm_transaction",
    venue: "evm",
    summary: "Stake 1 ETH with Lido",
    amountUsd: "3412",
    input: {
      chain: "1",
      calls: [{ to: LIDO, data: `0xa1903eab${OWNER.slice(2).padStart(64, "0")}`, value: "1" }],
      summary: "Stake 1 ETH with Lido",
      amount_usd: "3412",
      app: { name: "Lido", site: "lido.fi", verb: "stake" },
    },
    details: {
      network: "Ethereum",
      sendsUpTo: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE:1000000000000000000",
      getsAbout: `${STETH}:999800000000000000`,
      leavesTo: OWNER,
    },
    lines: [
      { label: "You give", value: "1 ETH ($3,412)" },
      { label: "You get", value: "0.9998 stETH ($3,409)" },
    ],
    card: {
      title: "Stake 1 ETH with Lido",
      action: "Stake {amount}",
      working: "Staking 1 ETH with Lido",
      context: "lido.fi on Ethereum",
      figures: [{ label: "You send", value: "1 ETH", note: "$3,412" }],
      finePrint: null,
      checks: {
        checked: "Checked by running it first",
        unchecked: null,
        why: "No app for Lido yet, so Auni read this by running it first.",
      },
      receipt: { title: "Staked 1 ETH with Lido", detail: null, amount: "spent" },
    },
    txs: [{ chain: "ethereum", hash: HASH }],
    ...fields,
  });

const everything = (feedback: Awaited<ReturnType<typeof bugReport>>) =>
  feedbackPost(feedback, new Set(feedback.optional.map(({ field }) => field)));

beforeEach(() => wipe(actions, threads));

describe("a request for an app", () => {
  const asked = { name: "Lido", site: "https://lido.fi/ethereum", asked: "Stake $3,412 of ETH" };

  it("says the service, what was asked with no amount, and the chain it ran on", async () => {
    const thread = await insertThread();
    await stake(thread.id);
    const feedback = await appRequest(thread.id, asked);
    expect(feedback).toMatchObject({
      kind: "app",
      heading: "Ask for a Lido app",
      title: "App request: Lido",
      always: [
        { field: "service", value: "Lido" },
        { field: "site", value: "lido.fi" },
        { field: "asked", value: "Stake # of ETH" },
        { field: "chain", value: "Ethereum" },
      ],
    });
  });

  it("keeps the steps and the link off until ticked, and holds no amount, argument or address of the owner's even then", async () => {
    const thread = await insertThread();
    await stake(thread.id);
    const feedback = await appRequest(thread.id, asked);
    expect(feedback.optional.map(({ field }) => field)).toEqual(["steps", "transaction"]);
    const steps = feedback.optional[0]!.value;
    expect(steps).toContain(`called ${LIDO} with 0xa1903eab, sending the chain's coin`);
    expect(steps).toContain("Tokens sent: the chain's own coin.");
    expect(steps).toContain(`Tokens got: ${STETH}.`);
    expect(steps).toContain("Permission left: none.");
    expect(feedback.optional[1]!.value).toBe(`https://etherscan.io/tx/${HASH}`);

    const ticked = everything(feedback);
    for (const posted of [ticked.url, ticked.text, decodeURIComponent(ticked.url)]) {
      expect(posted.toLowerCase()).not.toContain(OWNER.slice(2).toLowerCase());
      expect(posted).not.toMatch(/3,?412|3,?409|0\.9998|999800000000000000/u);
    }
    const bare = feedbackPost(feedback, new Set());
    expect(bare.url).not.toContain(HASH);
    expect(decodeURIComponent(bare.url)).not.toContain("0xa1903eab");
  });

  it("takes its steps only from moves of this thread that went through for that name with no app", async () => {
    const [here, elsewhere] = [await insertThread(), await insertThread()];
    await stake(elsewhere.id);
    await stake(here.id, { status: "failed" });
    await stake(here.id, { input: { chain: "1", calls: [], app: { name: "Rocket Pool" } } });
    // One an app of Auni's vouched for carries no `checks`: it is no evidence of a missing app.
    await stake(here.id, { card: null });
    const feedback = await appRequest(here.id, asked);
    expect(feedback.optional).toEqual([]);
    expect(feedback.always.map(({ field }) => field)).toEqual(["service", "site", "asked"]);
  });

  it("takes the owner's own address out of a part built from a record, too", async () => {
    const thread = await insertThread();
    // A transaction that sent a token named by the owner's own address: no real one does.
    await stake(thread.id, { details: { sendsUpTo: `${OWNER}:1`, getsAbout: "" } });
    const posted = everything(await appRequest(thread.id, asked)).text;
    expect(posted.toLowerCase()).not.toContain(OWNER.toLowerCase());
    expect(posted).toContain("Tokens sent: your wallet.");
  });

  it("takes the owner's own address out of a name or a sentence the agent wrote", async () => {
    const thread = await insertThread();
    const feedback = await appRequest(thread.id, {
      name: "Lido",
      asked: `Stake for ${SOLANA_OWNER} and ${OWNER} at https://rpc.example/v3/key`,
    });
    const posted = everything(feedback).text;
    expect(posted).not.toContain(SOLANA_OWNER);
    expect(posted.toLowerCase()).not.toContain(OWNER.toLowerCase());
    expect(posted).not.toContain("/v3/key");
  });

  it("takes the owner's address out when it is written without its 0x", async () => {
    const thread = await insertThread();
    const bare = OWNER.slice(2).toLowerCase();
    const posted = everything(
      await appRequest(thread.id, {
        name: "Lido",
        asked: `Stake for ${bare.slice(0, 20)} ${bare}`,
      }),
    ).text;
    expect(posted.toLowerCase()).not.toContain(bare);
  });
});

describe("a bug report", () => {
  const failed = (threadId: string, error: string) =>
    insertAction({
      threadId,
      status: "failed",
      tool: "send_evm_transaction",
      venue: "evm",
      error,
      failureKind: "unknown",
      attempts: 2,
      txs: [{ chain: "base", hash: HASH }],
    });

  it("always says the tool, why it stopped, the tries and Auni's version", async () => {
    const thread = await insertThread();
    const action = await failed(thread.id, "it reverted");
    const feedback = await bugReport({ happened: "The buy should have filled.", action });
    expect(feedback.always).toMatchObject([
      { field: "happened", value: "The buy should have filled." },
      { field: "tool", value: "send_evm_transaction" },
      { field: "failure", value: "unknown" },
      { field: "tries", value: "2" },
      { field: "version", value: expect.stringMatching(/^\d+\.\d+\.\d+/u) },
    ]);
  });

  // Live, 2026-11-14: the title was cut mid-word with no ellipsis ("...than the portfolio's cash tot").
  it("names a report about no move by what happened, cut at a word", async () => {
    const happened =
      "The sidebar's total read more than the portfolio's cash total after the withdrawal went out today.";
    const feedback = await bugReport({ happened });
    expect(feedback.title).toBe(
      "Bug: The sidebar's total read more than the portfolio's cash total after the…",
    );
    // What happened is posted whole, beside the title that cuts it.
    expect(feedback.always).toContainEqual(
      expect.objectContaining({ field: "happened", value: happened }),
    );
  });

  // Live, 2026-11-14: a report about Activity's perp detail was titled "Bug: Hyperliquid".
  it("names a report about an app by what happened, with the app on its own line", async () => {
    const happened = "Opening a closed Tesla short on Activity shows no profit or loss.";
    const feedback = await bugReport({ happened, app: "hyperliquid" });
    expect(feedback.title).toBe(`Bug: ${happened}`);
    expect(feedback.always).toContainEqual(
      expect.objectContaining({ field: "app", value: "Hyperliquid" }),
    );
    expect((await bugReport({ app: "hyperliquid" })).title).toBe("Bug: Hyperliquid");
  });

  it("says the move and why it stopped in the owner's words beside what is posted, and posts neither", async () => {
    const thread = await insertThread();
    const action = await insertAction({
      threadId: thread.id,
      status: "failed",
      tool: "stock_trade",
      venue: "monad",
      error: "it reverted",
      failureKind: "price",
      card: {
        title: "Buy COIN for {amount}",
        action: "Buy {amount}",
        working: "Buying COIN",
        context: null,
        figures: [],
        finePrint: null,
        receipt: { title: "Bought COIN", detail: null, amount: "spent" },
      },
    });
    const feedback = await bugReport({ action });
    // The title names the tool, never what the owner traded.
    expect(feedback.title).toBe("Bug: stock trade failed");
    expect(feedback.always.slice(0, 2)).toEqual([
      { field: "tool", label: "What Auni tried", value: "stock_trade", reads: "Buy COIN" },
      {
        field: "failure",
        label: "Why it stopped",
        value: "price",
        reads: "The price moved past what you allowed",
      },
    ]);
    const posted = everything(feedback);
    for (const text of [posted.text, decodeURIComponent(posted.url).replaceAll("+", " ")]) {
      expect(text).toContain("stock_trade");
      expect(text).not.toContain("COIN");
      expect(text).not.toContain("The price moved");
    }
  });

  it("keeps the raw error off until ticked, and scrubbed even then", async () => {
    const thread = await insertThread();
    const action = await failed(
      thread.id,
      `HTTP request failed. URL: https://mainnet.infura.io/v3/9aa3d95b3bc440fa88ea12eaa4456161 from ${OWNER} for 1250000000`,
    );
    const feedback = await bugReport({ action });
    expect(feedback.optional.map(({ field }) => field)).toEqual(["error", "transaction"]);
    const bare = decodeURIComponent(feedbackPost(feedback, new Set()).url);
    expect(bare).not.toContain("infura");
    expect(bare).not.toContain(HASH);
    const ticked = everything(feedback);
    for (const posted of [ticked.text, decodeURIComponent(ticked.url)]) {
      expect(posted).toContain("mainnet.infura.io");
      expect(posted).not.toContain("9aa3d95b3bc440fa88ea12eaa4456161");
      expect(posted).not.toContain("/v3/");
      expect(posted.toLowerCase()).not.toContain(OWNER.toLowerCase());
      expect(posted).not.toContain("1250000000");
    }
  });
});

describe("what only this owner has", () => {
  afterEach(() => {
    delete process.env.ELFA_AUTO_API_KEY;
  });

  it("is in no part, ticked or not, however a service echoed it", async () => {
    // A key the owner saved, which a service quoted back in a refusal no shape would know.
    process.env.ELFA_AUTO_API_KEY = "elfa_k3y_77aa";
    const thread = await insertThread();
    const action = await insertAction({
      threadId: thread.id,
      status: "failed",
      tool: "elfa_lookup",
      venue: "elfa",
      error: "401 invalid api key elfa_k3y_77aa for this plan",
      failureKind: "unknown",
    });
    const feedback = await bugReport({ action, happened: "It said elfa_k3y_77aa was wrong." });
    const posted = everything(feedback);
    for (const text of [posted.text, decodeURIComponent(posted.url)])
      expect(text).not.toContain("elfa_k3y_77aa");
    expect(posted.text).toContain("invalid api key … for this plan");
  });
});

describe("GET /feedback", () => {
  const url = serve(express().use("/feedback", feedbackRouter));

  it("answers what a report about a failed move would post, and 404 for one it doesn't know", async () => {
    const thread = await insertThread();
    const action = await insertAction({
      threadId: thread.id,
      status: "failed",
      error: "it reverted",
      failureKind: "unknown",
    });
    const answer = await fetch(url(`/feedback?action=${action.id}`));
    const { feedback } = feedbackWireSchema.parse(await answer.json());
    expect(feedback.kind).toBe("bug");
    expect(feedback.always.map(({ field }) => field)).toEqual([
      "tool",
      "failure",
      "tries",
      "version",
    ]);
    expect((await fetch(url(`/feedback?action=${crypto.randomUUID()}`))).status).toBe(404);
    expect((await fetch(url("/feedback?app=no-such-app"))).status).toBe(404);
    expect((await fetch(url("/feedback?action=not-an-id"))).status).toBe(400);
  });
});

describe("send_feedback", () => {
  it("returns a card core built, and reads no move of another thread", async () => {
    const [here, elsewhere] = [await insertThread(), await insertThread()];
    const other = await insertAction({ threadId: elsewhere.id, status: "failed", error: "secret" });
    const tool = sendFeedbackTool({ threadId: here.id });
    const refused = await tool.handler({
      kind: "bug",
      says: "It broke when I tried to buy.",
      action_id: other.id,
    });
    expect(refused.isError).toBe(true);
    const made = await tool.handler({ kind: "app", says: "Stake ETH with Lido", about: "Lido" });
    const card = feedbackCardSchema.parse(made.structuredContent?.card);
    expect(card.feedback.title).toBe("App request: Lido");
    expect((await tool.handler({ kind: "app", says: "Stake ETH with Lido" })).isError).toBe(true);
  });
});
