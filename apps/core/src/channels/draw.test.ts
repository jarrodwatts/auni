import { depositCardSchema } from "@auni/shared";
import { describe, expect, it } from "vitest";

import type { ActionRow } from "../db/schema.ts";
import { goneForGood } from "../money/gone-for-good.ts";
import {
  drawCard,
  drawLink,
  drawNotice,
  drawQuestion,
  fitsHere,
  literal,
  replySegments,
  shownKey,
  showsFullReview,
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
        [{ label: "Buy about $10 of Nvidia", press: "allow:g1" }],
        [{ label: "Decline", press: "decline:g1" }],
      ],
    });
  });

  it("keeps the amount on a full-width button when an asset name is very long", () => {
    const summary = "Buy about $10 of The Extraordinarily Long Asset Name";
    const message = drawCard(view([leg({ summary })]), "g");
    expect(message.text).toContain(summary);
    expect(message.buttons).toEqual([
      [{ label: "Buy about $10", press: "allow:g" }],
      [{ label: "Decline", press: "decline:g" }],
    ]);
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
      "**Save a routine: check-rates**\nWaiting on you\n\nThis card is too long to show in full here.",
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
      ["Landed: USDC on Base", "Allowed here."],
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
    expect(drawn.text).toContain(`**${literal("2 moves, $15 total")}**`);
    expect(drawn.text).toContain("> You give: 10 USDC");
    expect(drawn.text).toContain("> Price cap: $50 per share");
    expect(drawn.buttons?.flat()).toContainEqual({ label: "Buy both for $15", press: "allow:g" });

    const oversized = [leg(), { ...sell, lines: [{ label: "Terms", value: "x".repeat(3_500) }] }];
    expect(fitsHere(oversized)).toBe(false);
    const waiting = drawCard(view(oversized), "g");
    expect(waiting.text).toContain(
      "**1. Buy about $10 of Nvidia**\n**2. Buy $5 of Tesla**\n2 moves waiting on you",
    );
    expect(waiting.buttons?.flat()).toEqual([
      { label: "Open in Auni", url: "https://auni.example/app/chat/t" },
    ]);
    const settled = drawCard(
      view([
        { ...oversized[0]!, status: "done", run: { filled: "Bought 0.1 NVDAx" } },
        { ...oversized[1]!, status: "failed" },
      ]),
      null,
    );
    expect(settled.text).toContain("1 bought, 1 didn't go through");
    expect(settled.text).toContain(
      "**2. Buy $5 of Tesla**\nDidn't go through. Nothing left your wallet.",
    );
    expect(settled.buttons?.flat()).toEqual([
      { label: "Open in Auni", url: "https://auni.example/app/chat/t" },
    ]);
  });

  it("keeps the wallet outcome next to each failed or unsure move in an oversized plan", () => {
    const legs = [
      leg({
        status: "failed",
        failureKind: "sent",
        lines: [{ label: "Terms", value: "x".repeat(3_500) }],
      }),
      leg({ summary: "Buy Tesla", status: "running", phase: "unsure" }),
      leg({
        summary: "Buy gold",
        status: "running",
        phase: "needs_owner",
        run: { held: "unrecorded" },
      }),
    ];
    const { text } = drawCard(view(legs), null);
    expect(text).toContain(
      "**1. Buy about $10 of Nvidia**\nDidn't go through. Money may have moved or a fee may have been charged.",
    );
    expect(text).toContain(
      "**2. Buy Tesla**\nChecking whether it went through. Auni can't yet tell whether money moved.",
    );
    expect(text).toContain(
      "**3. Buy gold**\nMoney moved, but Auni couldn't confirm what came back",
    );
  });

  it("names the local computer for owner proof and removes approval buttons", () => {
    const drawn = drawCard(
      view([leg()], { proof: true, inTheApp: true, link: null, machine: "evo-t1" }),
      "g",
    );
    expect(drawn.text).toContain("Confirm it's you first.");
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

  it("puts the same loss warning as web on the card, even without a custom face", () => {
    const destroyed = leg({
      details: { leavesTo: "0x000000000000000000000000000000000000dEaD" },
      card: null,
    });
    const warning = goneForGood([destroyed.details.leavesTo!]);
    expect(warning).toBeTruthy();
    expect(drawCard(view([destroyed]), "grant").text).toContain(literal(warning!));
    expect(showsFullReview("review-v2:any")).toBe(false);
  });

  it("says what is known about money in failed, held, and unsure states", () => {
    for (const [row, words] of [
      [leg({ status: "failed", failureKind: "price" }), "Nothing left your wallet."],
      [leg({ status: "failed", failureKind: "sent" }), "Money may have moved"],
      [leg({ status: "running", phase: "unsure" }), "can't yet tell whether money moved"],
      [leg({ status: "running", phase: "needs_owner" }), "can't confirm whether money moved"],
      [
        leg({ status: "running", phase: "needs_owner", run: { held: "unrecorded" } }),
        "Money moved, but Auni couldn't confirm what came back",
      ],
    ] as const)
      expect(drawCard(view([row]), null).text).toContain(words);
  });

  it("puts the network fee purchase alongside the facts above the status", () => {
    const row = leg({
      details: {
        feeCoinOn: "monad",
        feeCoinFrom: "monad",
        feeCoinToken: "native",
        feeCoinAmount: "500000000000000",
        feeCoinUsd: "0.50",
        feeCoinBy: "KyberSwap",
      },
    });
    const text = drawCard(view([row]), "g").text;
    expect(text).toMatch(/> You get: NVDAx\n> Also buys [^\n]+\nWaiting on you/u);
  });

  it("keeps the amount and route on a landed bridge receipt and sizes the plan's button", () => {
    const bridge = leg({
      tool: "bridge_usdc",
      input: { from_chain: "polygon", to_chain: "monad", amount: "10" },
      summary: "Move $10 of USDC from Polygon to Monad",
      lines: [{ label: "You send", value: "10 USDC on Polygon" }],
    });
    const bought = leg({ input: { stock: "NVDA", side: "buy", chain: "monad" } });
    const plan = drawCard(view([bridge, bought]), "grant");
    expect(plan.buttons).toEqual([
      [{ label: "Move and buy ($10)", press: "allow:grant" }],
      [{ label: "Decline", press: "decline:grant" }],
    ]);
    const landed = drawCard(
      view([{ ...bridge, status: "done", run: { lands: "USDC on Monad" } }]),
      null,
    );
    expect(landed.text).toContain("10 USDC on Polygon");
    expect(landed.text).toContain("Landed: USDC on Monad");
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
      "**2. Sell 10 Yes shares**\n> Lets: Polymarket's exchanges trade the shares in your Polymarket wallet",
    );
  });

  // Found in review: a card whose warning already says its permission said it twice.
  it("says a permission once when the card's warning already says it", () => {
    const lets = "Polymarket's exchanges trade the shares in your Polymarket wallet";
    const sale = leg({
      summary: "Sell 10 Yes shares",
      lines: [{ label: "Lets", value: lets }],
      card: {
        title: "Sell 10 Yes shares",
        figures: [],
        warning: `From now on, it lets ${lets}.`,
      } as unknown as ActionRow["card"],
    });
    const text = drawCard(view([sale]), "g").text;
    expect(text.split(literal(lets))).toHaveLength(2);
    expect(text).not.toContain("Lets:");
    // With no warning saying it, the Lets line stays.
    expect(drawCard(view([{ ...sale, card: null }]), "g").text).toContain(`Lets: ${literal(lets)}`);
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
    expect(twelve.text).toContain(`moves, $120 total**\n\n${why}\n\n**1. Sell 1 Yes shares**`);
    expect(twelve.text.split(why)).toHaveLength(2);
    expect(twelve.buttons).toBeUndefined();
    // Too long to show whole, it still says why.
    expect(drawCard(view(takenBack(plan(200))), null)).toEqual({
      text: `**200 moves, $2,000 total**\n${why}`,
    });
  });

  // Found in review: a long plan that fit while it waited, once some moves went and one was
  // paused, showed only its heading, saying neither which went nor where to look.
  it("keeps a decided plan's permissions out, and sends one too long for its outcomes to the app", () => {
    const lets = { label: "Lets", value: "Polymarket's exchanges trade your shares. ".repeat(4) };
    const plan = Array.from({ length: 12 }, (_, index) =>
      leg({ id: `a${index}`, summary: `Buy ${index + 1} Yes shares`, lines: [lets] }),
    );
    expect(fitsHere(plan)).toBe(true);
    const went = plan.map((each, index) =>
      index === 0
        ? { ...each, status: "failed" as const, error: "Paused before sending. ".repeat(8) }
        : { ...each, status: "done" as const },
    );
    expect(drawCard(view(went), null).text).not.toContain("Lets:");
    const long = went.map((each) => ({ ...each, summary: `${each.summary} ${"x".repeat(240)}` }));
    const drawn = drawCard(view(long), null);
    expect(drawn.text).toContain(
      "This plan is too long to show in full here. Auni shows each move.",
    );
    expect(drawn.text).toContain("1 didn't go through, 11 completed");
    expect(drawn.buttons).toEqual([
      [{ label: "Open in Auni", url: "https://auni.example/app/chat/t" }],
    ]);
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

  it("gathers thinking across cards into one fold on the answer", () => {
    const card = { kind: "action", actionReference: "a1", title: "Buy" };
    expect(
      replySegments([
        { type: "data-reasoning", data: { text: "Before" } },
        { type: "data-cards", data: { cards: [card] } },
        { type: "reasoning", text: "After" },
        { type: "text", text: "Answer" },
      ]),
    ).toEqual([
      { kind: "card", card },
      { kind: "text", text: "Answer", detail: "**Thinking**\n\nBefore\n\nAfter" },
    ]);
  });

  it("keeps agent reasoning off cards when the reply contains only sealed cards", () => {
    const card = { kind: "deposit", title: "Deposit USDC" };
    expect(
      replySegments([
        { type: "reasoning", text: "Use this address: `0x123`" },
        { type: "data-cards", data: { cards: [card] } },
      ]),
    ).toEqual([{ kind: "card", card }]);
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
    expect(base.text).toContain(`**Your wallet address**\n\`${wallet.evm}\`\n> Use on Base`);
    expect(base.text).not.toContain(deposit.tokens[0]?.address);
    expect(base.text.match(/`[^`]+`/gu)).toEqual([`\`${wallet.evm}\``]);
    expect(base.buttons).toEqual([[{ label: "Copy Base wallet address", copy: wallet.evm }]]);
    const solana = drawNotice({ ...deposit, network: "solana" }, where, wallet);
    expect(solana.buttons).toEqual([
      [{ label: "Copy Solana wallet address", copy: wallet.solana }],
    ]);
    const unknown = drawNotice({ ...deposit, network: null }, where, wallet);
    expect(unknown.buttons?.flat().map((button) => "copy" in button && button.copy)).toEqual([
      wallet.evm,
      wallet.solana,
    ]);
    expect(unknown.text).toContain(`${wallet.evm}\`\n> Use on Monad, Base, Arbitrum`);
    expect(unknown.text).toContain(`${wallet.solana}\`\n> Use on Solana`);
    expect(unknown.text).not.toContain(deposit.tokens[0]?.address);
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
