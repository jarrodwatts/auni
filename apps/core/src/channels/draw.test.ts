import { describe, expect, it } from "vitest";

import type { ActionRow } from "../db/schema.ts";
import {
  drawCard,
  drawLink,
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
      text: "**Buy about $10 of Nvidia**\nYou give: 10 USDC\nYou get: NVDAx\nWaiting for you",
      buttons: [
        [
          { label: "Allow", press: "allow:g1" },
          { label: "Decline", press: "decline:g1" },
        ],
      ],
    });
  });

  it("sends a card that takes the owner's proof to the app, with no button that decides it", () => {
    const drawn = drawCard(view([leg()], { inTheApp: true }), "g1");
    expect(drawn.buttons).toEqual([
      [{ label: "Open in the app", url: "https://auni.example/app/chat/t" }],
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
      "**Save a routine: check-rates**\nWaiting for you\nIt's too long to show here in full, so it's allowed in the app, where all of it shows.",
    );
    expect(drawn.buttons).toEqual([
      [{ label: "Open in the app", url: "https://auni.example/app/chat/t" }],
    ]);
    expect(drawCard(view([{ ...long, status: "done" }], { decidedIn: "the app" }), null).text).toBe(
      "**Save a routine: check-rates**\nSaved\nAllowed in the app.",
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
          .slice(-2),
      ),
    ).toEqual([
      ["Starting", "Allowed here."],
      ["Running", "Allowed here."],
      ["Sent, on its way", "Allowed here."],
      ["Landed", "Allowed here."],
    ]);
    expect(drawCard(view([leg({ status: "done" })]), null).buttons).toBeUndefined();
  });

  it("says a card was declined elsewhere, and says nothing of one a newer card replaced", () => {
    expect(
      drawCard(view([leg({ status: "cancelled" })], { decidedIn: "the app" }), null).text,
    ).toMatch(/Declined\nDeclined in the app\.$/u);
    expect(
      drawCard(view([leg({ status: "replaced" })], { decidedIn: "the app" }), null).text,
    ).toMatch(/Replaced by a newer card$/u);
  });

  it("draws a plan's legs one per line under one pair of buttons", () => {
    const legs = [leg(), leg({ id: "a2", summary: "Move $5 to Solana" })];
    const drawn = drawCard(view(legs), "g");
    expect(drawn.text).toBe(
      "**A plan of 2 moves, one tap for all of them**\n1. Buy about $10 of Nvidia: Waiting for you\n2. Move $5 to Solana: Waiting for you",
    );
    expect(drawn.buttons).toHaveLength(1);
  });

  it("says each leg's permissions on a plan, since one Allow grants them all", () => {
    const sale = leg({
      id: "a2",
      summary: "Sell 10 Yes shares",
      lines: [
        {
          label: "Lets",
          value: "Polymarket's exchanges trade the shares in your Polymarket wallet",
        },
      ],
    });
    expect(drawCard(view([leg(), sale]), "g").text).toContain(
      "2. Sell 10 Yes shares: Waiting for you\nLets: Polymarket's exchanges trade the shares in your Polymarket wallet",
    );
  });

  it("says once why a plan was taken back, even one too long to show whole, and offers no tap", () => {
    const why = "Out of date: Auni's cards now say more about each move.";
    const plan = (length: number) =>
      Array.from({ length }, (_, index) =>
        leg({
          id: `a${index}`,
          summary: `Sell ${index + 1} Yes shares`,
          lines: [{ label: "Lets", value: "Polymarket's exchanges trade your shares. ".repeat(4) }],
        }),
      );
    const takenBack = (legs: ActionRow[]) =>
      legs.map((each) => ({ ...each, status: "retracted" as const, error: why }));
    // Twelve fit while they wait, and still do taken back, saying why once.
    expect(fitsHere(plan(12))).toBe(true);
    const twelve = drawCard(view(takenBack(plan(12))), null);
    expect(twelve.text).toMatch(
      new RegExp(`^\\*\\*A plan of 12 moves\\*\\*\\n${why}\\n1\\. Sell 1 Yes shares\\n`, "u"),
    );
    expect(twelve.text.split(why)).toHaveLength(2);
    expect(twelve.buttons).toBeUndefined();
    // Too long to show whole, it still says why.
    expect(drawCard(view(takenBack(plan(30))), null)).toEqual({
      text: `**A plan of 30 moves**\n${why}`,
    });
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
    expect(drawCard(view([bridge, sale]), "g").text).toMatch(new RegExp(`\\n${said}$`, "u"));
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
    text.replace(/^\*\*|\*\*(?=\n|$)/gmu, "").replace(/\\./gu, "");

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
    expect(drawn[0]!.text.split("\n")[0]).toBe(`**${literal(HOSTILE)}**`);
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
