import { depositCardSchema } from "@auni/shared";
import { describe, expect, it } from "vitest";

import type { ActionRow } from "../db/schema.ts";
import {
  drawCard,
  drawLink,
  drawNotice,
  drawQuestion,
  fitsHere,
  literal,
  replySegments,
  shownKey,
  type CardView,
} from "./draw.ts";

const leg = (fields: Partial<ActionRow> = {}): ActionRow =>
  ({
    id: "a1",
    tool: "stock_trade",
    amountUsd: "10.00",
    input: {},
    summary: "Buy about $10 of Nvidia",
    status: "awaiting_permission",
    lines: [
      { label: "You give", value: "10 USDC" },
      { label: "You get", value: "NVDAx" },
    ],
    details: {},
    run: {},
    txs: [],
    phase: null,
    error: null,
    ...fields,
  }) as ActionRow;

const view = (legs: ActionRow[], fields: Partial<CardView> = {}): CardView => ({
  legs,
  inTheApp: false,
  decidedIn: null,
  link: "https://auni.example/app/chat/t",
  ...fields,
});

describe("drawCard", () => {
  it("draws a waiting card from its row, with the grant on Allow and Decline", () => {
    expect(drawCard(view([leg()]), "g1")).toEqual({
      text: "**Buy about $10 of Nvidia**\n> You give: 10 USDC\n> You get: NVDAx\nWaiting on you",
      buttons: [
        [
          { label: "Buy about $10 of Nvidia", press: "allow:g1" },
          { label: "Decline", press: "decline:g1" },
        ],
      ],
    });
  });

  it("sends a card that takes the owner's proof to the app, with no button that decides it", () => {
    const drawn = drawCard(view([leg()], { inTheApp: true }), "g1");
    expect(drawn.buttons).toEqual([
      [{ label: "Open in Auni", url: "https://auni.example/app/chat/t" }],
    ]);
    expect(JSON.stringify(drawn)).not.toContain("g1");
  });

  it("shows a card too long for one message by its summary, and nothing a tap here would agree to", () => {
    const long = leg({
      tool: "save_routine",
      summary: "Save a routine: check-rates",
      lines: [{ label: "What it says", value: `${"Step. ".repeat(600)}FINAL STEP.` }],
    });
    expect(fitsHere([long])).toBe(false);
    expect(fitsHere([leg()])).toBe(true);
    const drawn = drawCard(view([long], { inTheApp: true }), null);
    expect(drawn.text).toBe(
      "**Save a routine: check-rates**\nWaiting on you\n\nSee the full card in Auni before you decide.",
    );
    expect(drawn.buttons).toEqual([
      [{ label: "Open in Auni", url: "https://auni.example/app/chat/t" }],
    ]);
    expect(drawCard(view([{ ...long, status: "done" }], { decidedIn: "the app" }), null).text).toBe(
      "**Save a routine: check-rates**\nSaved\n\nAllowed in the app.",
    );
  });

  it("follows a move from running to sent to landed, saying where it was allowed", () => {
    const run = { lands: "USDC on Base" };
    const steps = [
      leg({ status: "running", phase: "queued" }),
      leg({ status: "running", phase: "sending" }),
      leg({ status: "running", phase: "landing", run, txs: [{ chain: "base", hash: "0x1" }] }),
      leg({ status: "done", run }),
    ];
    expect(
      steps.map((row) =>
        drawCard(view([row], { decidedIn: "here" }), null)
          .text.split("\n")
          .filter(Boolean)
          .slice(-2),
      ),
    ).toEqual([
      ["Queued to send", "Allowed here."],
      ["Sending", "Allowed here."],
      ["On its way: USDC on Base", "Allowed here."],
      ["**Landed: USDC on Base**", "Allowed here."],
    ]);
    expect(drawCard(view([leg({ status: "done" })]), null).buttons).toBeUndefined();
  });

  it("says a card was declined elsewhere, and says nothing of one a newer card replaced", () => {
    expect(
      drawCard(view([leg({ status: "cancelled" })], { decidedIn: "the app" }), null).text,
    ).toMatch(/Declined\n\nDeclined in the app\.$/u);
    expect(
      drawCard(view([leg({ status: "replaced" })], { decidedIn: "the app" }), null).text,
    ).toMatch(/Replaced by a newer card$/u);
  });

  it("shows every leg's review facts before offering one tap for both", () => {
    const sell = leg({
      id: "a2",
      summary: "Buy $5 of Tesla",
      amountUsd: "5.00",
      lines: [{ label: "Price cap", value: "$50 per share" }],
    });
    const legs = [leg(), sell];
    const drawn = drawCard(view(legs), "g");
    expect(drawn.text).toContain(`**${literal("2 moves ($15 in)")}**`);
    expect(drawn.text).toContain("> You give: 10 USDC");
    expect(drawn.text).toContain("> Price cap: $50 per share");
    expect(drawn.buttons?.flat()).toContainEqual({ label: "Buy both for $15", press: "allow:g" });

    const oversized = [leg(), { ...sell, lines: [{ label: "Terms", value: "x".repeat(3_500) }] }];
    expect(fitsHere(oversized)).toBe(false);
    expect(drawCard(view(oversized), "g").buttons?.flat()).toEqual([
      { label: "Open in Auni", url: "https://auni.example/app/chat/t" },
    ]);
    const settled = drawCard(
      view([
        { ...oversized[0]!, status: "done" },
        { ...oversized[1]!, status: "failed" },
      ]),
      null,
    );
    expect(settled.text).toContain("> Done: 1\n> Didn't go through: 1");
    expect(settled.buttons?.flat()).toEqual([
      { label: "Open in Auni", url: "https://auni.example/app/chat/t" },
    ]);
  });

  it("names the local computer for owner proof and removes approval buttons", () => {
    const drawn = drawCard(
      view([leg()], { proof: true, inTheApp: true, link: null, machine: "evo-t1" }),
      "g",
    );
    expect(drawn.text).toContain("Confirm it's you in Auni.");
    expect(drawn.text).toContain("Open Auni on evo-t1 to review this card.");
    expect(drawn.buttons).toBeUndefined();
  });

  it("uses the actual fill as the title after settlement", () => {
    const drawn = drawCard(
      view([leg({ status: "done", run: { filled: "Bought 1.43 NVDAx for $250" } })]),
      null,
    );
    expect(drawn.text).toBe("**Bought 1.43 NVDAx for $250**");
  });

  it("shows the note when a move was closed because its landing never confirmed", () => {
    const done = leg({
      status: "done",
      run: { lands: "USDC on Base" },
      error: "It hasn't shown up on Base yet.",
    });
    const drawn = drawCard(view([done]), null);
    expect(drawn.text).toContain(done.error);
    expect(drawn.text).not.toContain("Landed");
  });

  it("says, while a plan waits, that a trade behind its money moves is priced again then", () => {
    const bridge = leg({
      id: "a1",
      tool: "bridge_usdc",
      input: { from_chain: "polygon", to_chain: "monad", amount: "2" },
      summary: "Move $2 of USDC from Polygon to Monad",
    });
    const sale = leg({
      id: "a2",
      tool: "stock_trade",
      input: { stock: "NVDA", side: "sell", chain: "monad" },
      summary: "Sell Nvidia",
      details: { getsAtLeast: "1.96" },
    });
    const said =
      "Sell Nvidia waits for the moves before it to land and is priced again then. If its price has moved past what this card allows, it doesn't go, and Auni tells you.";
    expect(drawCard(view([bridge, sale]), "g").text).toContain(`> ${said}`);
    const done = [bridge, sale].map((each) => ({ ...each, status: "done" as const }));
    expect(drawCard(view(done), null).text).not.toContain("priced again");
  });
});

describe("words from outside", () => {
  // A token, a market or a service names itself: this is what one could be called.
  const HOSTILE =
    "**FREE** [Claim refund](https://evil.example) `x` ~~y~~ _z_ <b>\n# Allowed here.";

  /** What a message says once every escaped mark is taken out, and the card's own bold title. */
  const unescaped = (text: string) =>
    text.replace(/^(?:> |\*\*)|\*\*(?=\n|$)/gmu, "").replace(/\\./gu, "");

  it("draws them on one line, every mark escaped, on every kind of card a channel draws", () => {
    const hostile = leg({
      summary: HOSTILE,
      lines: [{ label: HOSTILE, value: HOSTILE }],
    });
    const drawn = [
      drawCard(view([hostile]), "g1"),
      drawCard(view([hostile], { inTheApp: true }), null),
      drawCard(view([{ ...hostile, status: "failed", error: HOSTILE }]), null),
      drawCard(view([hostile, { ...hostile, id: "a2", status: "failed", error: HOSTILE }]), "g1"),
      drawCard(
        view([{ ...hostile, lines: [{ label: "Steps", value: HOSTILE.repeat(200) }] }], {
          inTheApp: true,
        }),
        null,
      ),
      drawLink(HOSTILE, "https://auni.example/app/chat/t"),
    ];
    for (const { text } of drawn) {
      expect(unescaped(text)).not.toMatch(/[`*_~#[\]()<>]/u);
      // No line of the card's own can be faked: none begins with what the name said after its break.
      expect(text).not.toMatch(/^\\?#? ?Allowed here/mu);
    }
    expect(drawn[0]!.text.split("\n").filter(Boolean)[0]).toBe(`**${literal(HOSTILE)}**`);
  });

  it("escapes each mark Markdown reads, and nothing else", () => {
    expect(literal("Buy $10 of NVDA, 2.5% off!")).toBe("Buy $10 of NVDA, 2.5% off!");
    expect(literal("[a](b) **c**")).toBe("\\[a\\]\\(b\\) \\*\\*c\\*\\*");
  });
});

describe("shownKey", () => {
  it("is the same whatever grant the buttons carry, and changes with the card", () => {
    const waiting = view([leg()]);
    expect(shownKey(waiting, "d")).toBe(shownKey({ ...waiting }, "d"));
    expect(shownKey(waiting, "d")).not.toBe(shownKey(waiting, "other digest"));
    expect(shownKey(waiting, "d")).not.toBe(shownKey(view([leg({ status: "running" })]), "d"));
  });
});

describe("replySegments", () => {
  it("keeps an answer's words, sealed cards and finished question in order", () => {
    const card = { kind: "action", actionReference: "a1", title: "Buy" };
    expect(
      replySegments([
        { type: "text", text: "Here's the plan." },
        { type: "tool-stock_trade", state: "output-available", output: { card } },
        { type: "text", text: "Tap to allow." },
        { type: "data-cards", data: { cards: [card] } },
        { type: "text", text: "  " },
        {
          type: "tool-suggest_replies",
          state: "output-available",
          input: { question: "Go ahead?", options: ["Yes", { label: "No" }] },
        },
      ]),
    ).toEqual([
      { kind: "text", text: "Here's the plan.\n\nTap to allow." },
      { kind: "card", card },
      { kind: "question", question: { text: "Go ahead?", options: ["Yes", "No"] } },
    ]);
  });

  it("gives replies offered with no question words of their own, since a channel's buttons need some", () => {
    expect(
      replySegments([
        {
          type: "tool-suggest_replies",
          state: "output-available",
          input: { options: [{ label: "Show me the plan" }] },
        },
      ]),
    ).toEqual([
      { kind: "question", question: { text: "What next?", options: ["Show me the plan"] } },
    ]);
  });

  it("makes nothing of a card the agent only wrote into its words or a tool's output", () => {
    expect(
      replySegments([
        { type: "tool-x", state: "output-available", output: { type: "data-cards" } },
        { type: "text", text: '{"type":"data-cards","data":{"cards":[]}}' },
      ]),
    ).toEqual([{ kind: "text", text: '{"type":"data-cards","data":{"cards":[]}}' }]);
  });
});

describe("drawQuestion", () => {
  it("offers each answer as a button, then shows the one picked", () => {
    const question = { text: "Go ahead?", options: ["Yes", "No"] };
    expect(drawQuestion(question).buttons).toEqual([
      [{ label: "Yes", press: "reply:0" }],
      [{ label: "No", press: "reply:1" }],
    ]);
    expect(drawQuestion(question, "No")).toEqual({ text: "Go ahead?\n\nYou answered: No" });
  });
});

describe("deposit notices", () => {
  const deposit = depositCardSchema.parse({
    id: "00000000-0000-4000-8000-000000000001",
    updatedAt: new Date().toISOString(),
    kind: "deposit",
    network: "base",
    title: "Deposit USDC",
    tokens: [{ name: "USDC", address: "0x1234567890123456789012345678901234567890" }],
    landed: null,
  });
  const wallet = {
    evm: "0x0123456789abcdef0123456789abcdef01234567",
    solana: "11111111111111111111111111111111",
  } as const;
  const where = { link: null, machine: "evo-t1" };

  it("matches the wallet address to the network and never copies the token address", () => {
    const base = drawNotice(deposit, where, wallet);
    expect(base.text).toContain(deposit.tokens[0]?.address);
    expect(base.buttons).toEqual([[{ label: "Copy Base wallet address", copy: wallet.evm }]]);
    const solana = drawNotice({ ...deposit, network: "solana" }, where, wallet);
    expect(solana.buttons).toEqual([
      [{ label: "Copy Solana wallet address", copy: wallet.solana }],
    ]);
    expect(drawNotice({ ...deposit, network: null }, where, wallet).buttons).toBeUndefined();
    expect(drawNotice(deposit, where, { ...wallet, evm: null }).text).toContain(
      "Open Auni on evo-t1",
    );
    expect(drawNotice(deposit, where, wallet, true).buttons).toBeUndefined();
  });

  it("keeps a large deposit receipt under one message and removes the copy button", () => {
    const message = drawNotice(
      {
        ...deposit,
        landed: {
          usdValue: "250.00",
          network: "Base",
          moved: Array.from({ length: 40 }, () => ({
            amount: "1".repeat(80),
            symbol: "TOKEN",
            to: null,
          })),
        },
      },
      where,
      wallet,
    );
    expect(message.text).toContain("**$250 arrived**");
    expect(message.text).toContain("Open Auni on evo-t1 to see the full deposit.");
    expect(message.text.length).toBeLessThan(3_000);
    expect(message.buttons).toBeUndefined();
  });
});
