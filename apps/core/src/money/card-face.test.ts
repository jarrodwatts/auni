import { cardFaceSchema, fillFace, type CardFace } from "@auni/shared";
import { describe, expect, it } from "vitest";

import {
  appFace,
  costFigures,
  fitted,
  plainFace,
  tradeFace,
  withdrawalFace,
  withFace,
  tooMuchToShow,
  withLeaves,
  type AppTerms,
  type TradeTerms,
} from "./card-face.ts";
import { costsTogether, effectLines } from "./effect.ts";
import { grantLabel } from "./wallet-effect.ts";

const TOKEN_A = "0x1111111111111111111111111111111111111111";
const TOKEN_B = "0x3333333333333333333333333333333333333333";
const SPENDER = "0x2222222222222222222222222222222222222222";

// What each of core's own cards says, as the owner reads it: the face a move wrote, with the
// card's amount filled in as the web and every channel fill it (fillFace).

const usdc = (baseUnits: string) => ({ baseUnits, currency: { code: "USDC", decimals: 6 } });
const MOVES = { moves: true };

const stockBuy: TradeTerms = {
  side: "buy",
  symbol: "NVDAx",
  stock: { company: "Nvidia", ticker: "NVDA" },
  chain: "solana",
  receive: "0.27",
  selling: null,
  atLeast: null,
  price: "$184.20",
  costs: [],
};
const stockSell: TradeTerms = {
  side: "sell",
  symbol: "NVDAx",
  stock: { company: "Nvidia", ticker: "NVDA" },
  chain: "solana",
  receive: null,
  selling: "0.0054 NVDAx",
  atLeast: "$0.98",
  price: "$184.20",
  costs: [],
};

describe("a trade's face", () => {
  it("reads a stock buy by its company, what it pays and what it gets", () => {
    const content = fillFace(tradeFace(stockBuy, MOVES), usdc("50000000"));
    expect(content.title).toBe("Buy Nvidia for $50");
    expect(content.action).toBe("Buy $50");
    expect(content.context).toBe("NVDA, a tokenized stock");
    expect(content.figures).toEqual([
      { label: "You pay", value: "$50", role: "pays" },
      { label: "You get, about", value: "0.27 shares", role: "gets" },
      { label: "Price", value: "$184.20" },
    ]);
    expect(content.price).toBe("$184.20");
  });

  it("says a stock sell's money comes back", () => {
    const content = fillFace(tradeFace(stockSell, MOVES), usdc("990000"));
    expect(content.action).toBe("Sell $0.99");
    expect(content.receipt).toMatchObject({ title: "Sold Nvidia", amount: "$0.99 back" });
  });

  it("says what a filled sale brought back, not what its card priced, as the agent's report does", () => {
    const face = tradeFace(
      { ...stockSell, chain: "monad", selling: "0.004683 NVDAx", atLeast: "0.9787 USDC" },
      MOVES,
    );
    // The face is written once; the card's amount is what core recorded the sale brought back.
    expect(fillFace(face, usdc("980000")).receipt).toMatchObject({
      title: "Sold Nvidia",
      amount: "$0.98 back",
    });
  });

  it("names what it sells on its button when the sale couldn't be priced", () => {
    const content = fillFace(tradeFace(stockSell, { moves: false }), usdc("0"));
    expect(content.action).toBe("Sell Nvidia");
    expect(content.receipt.amount).toBeNull();
  });

  it("names each cost and the service it goes through in plain words", () => {
    const face = tradeFace(
      {
        ...stockBuy,
        costs: [
          { label: "network fee", usd: 0.02 },
          { label: "price impact", usd: 0.25 },
        ],
        through: "KyberSwap",
      },
      MOVES,
    );
    expect(face.figures.slice(3)).toEqual([
      { label: "Network fee", value: "$0.02" },
      { label: "Price impact", value: "$0.25" },
      { label: "Via", value: "KyberSwap" },
    ]);
  });

  it("names a token by its ticker and the chain it trades on", () => {
    const face = tradeFace({ ...stockBuy, symbol: "JUP", stock: null }, MOVES);
    expect(face).toMatchObject({ context: "On Solana", working: "Buying JUP" });
    expect(fillFace(face, usdc("5000000")).figures[1]).toEqual({
      label: "You get, about",
      value: "0.27 JUP",
      role: "gets",
    });
  });
});

describe("a withdrawal's face", () => {
  const terms = {
    to: "0x1a2B…fa0b",
    network: "Solana",
    arrives: "In about a minute",
    fee: "$0.07",
  };
  const summary = "Withdraw $5 to your wallet on Solana";

  it("says where the cash goes, on which network, when, and what moving it costs", () => {
    const content = fillFace(withdrawalFace(terms, { summary }), usdc("5000000"));
    expect(content).toMatchObject({
      title: summary,
      action: "Withdraw $5",
      working: "Sending it out",
      figures: [
        { label: "To", value: "0x1a2B…fa0b" },
        { label: "Network", value: "Solana" },
        { label: "Arrives", value: "In about a minute" },
      ],
      finePrint: "Includes a $0.07 fee to move it between networks.",
      receipt: { title: "Withdrew $5 to your wallet on Solana", detail: "To 0x1a2B…fa0b" },
    });
    // Its sentence says the dollars already, so its receipt doesn't say them twice.
    expect(content.receipt.amount).toBeNull();
  });

  it("says nothing under its figures when it costs nothing", () => {
    const free = withdrawalFace({ ...terms, fee: null }, { summary });
    expect(free.finePrint).toBeNull();
  });
});

const leg = { amount: "50", symbol: "USDC", name: "USD Coin", usd: "$50" };
const deposit: AppTerms = {
  app: "Aave",
  site: "aave.com",
  logo: { src: "https://t1.gstatic.com/faviconV2?url=https://aave.com", inset: true },
  layout: "deposit",
  chain: "Base",
  toChain: null,
  sends: [leg],
  gets: [{ amount: "50", symbol: "aBasUSDC", name: "USDC", usd: "$50" }],
  price: null,
  vsMarket: null,
  networkFee: null,
  leaves: "0x2222…2222 spend your USDC",
  to: [],
  title: null,
  finePrint: null,
  via: null,
  contract: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  vouched: false,
  note: null,
  unknownTo: null,
};

describe("the face of a transaction the agent built for an app", () => {
  const said = { summary: "Put $50 of USDC into Aave on Base", moves: true };

  it("reads a deposit as the app's", () => {
    const content = fillFace(appFace(deposit, said), usdc("50000000"));
    expect(content).toMatchObject({
      title: "Put USDC into Aave",
      note: "to put in",
      action: "Put in $50",
      context: "Aave on Base",
      figures: [
        { label: "You put in", value: "50 USDC", note: "$50" },
        { label: "You get back", value: "50 aBasUSDC", note: "$50" },
        // No app vouches for it, so the contract it calls is said whole, to be checked.
        { label: "Contract", value: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" },
      ],
      finePrint: null,
      receipt: { title: "Put USDC into Aave" },
    });
  });

  it("wears the app's own logo, else its name alone, never the token it trades", () => {
    expect(appFace(deposit, said).logo).toEqual({
      src: "https://t1.gstatic.com/faviconV2?url=https://aave.com",
      inset: true,
      name: "Aave",
    });
    expect(appFace({ ...deposit, logo: null }, said).logo).toEqual({
      src: null,
      inset: false,
      name: "Aave",
    });
  });

  it("draws a move to another chain as a route, and says it lands later", () => {
    const face = appFace({ ...deposit, layout: "move", toChain: "Ethereum", leaves: null }, said);
    expect(face).toMatchObject({
      title: "Move USDC to Ethereum",
      scene: { kind: "route", from: "Base", sends: "50 USDC", to: "Ethereum" },
      receipt: { title: "Sent USDC to Ethereum", detail: "Usually lands in a few minutes" },
    });
    expect(face.finePrint).toBe("Bridges usually take a few minutes to land.");
    expect(face.figures.at(-1)).toEqual({
      label: "Contract",
      value: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    });
  });

  it("says anything else in the agent's own sentence, and that nothing is left able to spend", () => {
    const face = appFace({ ...deposit, layout: null, leaves: null }, said);
    expect(fillFace(face, usdc("50000000"))).toMatchObject({
      title: "Put $50 of USDC into Aave on Base",
      note: "to put",
      action: "Put $50",
      working: "Putting in $50 of USDC into Aave on Base",
      context: "aave.com on Base",
      finePrint: "It leaves nothing able to spend your money afterwards.",
      receipt: { title: "Put $50 of USDC into Aave on Base", amount: "$50" },
    });
  });
});

describe("a card no app vouches for", () => {
  const said = { summary: "Stake 1 ETH with Lido", moves: true };
  const stake: AppTerms = { ...deposit, app: "Lido", layout: null, leaves: null };

  it("says which of its words Auni checked, and why it reads this way", () => {
    expect(appFace(stake, said).checks).toEqual({
      checked: "Observed in simulation",
      unchecked: null,
      why: "No app for Lido yet, so Auni simulated it to show what it does.",
    });
  });

  it("sets the agent's own sentence apart, under a heading that says nobody checked it", () => {
    const note = "stETH earns about 3% a year. Turning it back into ETH can take days.";
    const noted = appFace({ ...stake, note }, said);
    expect(noted.checks?.unchecked).toEqual({
      heading: "Auni's note (unverified)",
      says: note,
    });
    // The sentence is nowhere among the words the heading above them calls checked, and
    // changes none of them.
    const checked = ({ checks: _apart, ...rest }: CardFace) => rest;
    expect(JSON.stringify(checked(noted))).not.toContain("stETH earns");
    expect(checked(noted)).toEqual(checked(appFace(stake, said)));
  });

  it("says that nothing comes back when the simulation saw nothing come back", () => {
    const given = appFace({ ...stake, gets: [] }, said);
    expect(given.figures).toEqual([
      { label: "You send", value: "50 USDC", note: "$50", role: "pays" },
      { label: "You get", value: "Nothing back" },
      { label: "Contract", value: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" },
    ]);
    // Sent to someone's wallet, it is a send, to the whole address the owner checks.
    const friend = "0x97c5e2b14D8A6F3c0E9b7A51D2c4F86e3a1D0b91";
    expect(appFace({ ...stake, gets: [], to: [friend] }, said).figures).toEqual([
      { label: "You send", value: "50 USDC", note: "$50", role: "pays" },
      { label: "To", value: friend },
      { label: "Contract", value: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" },
    ]);
    // One that only brings something in has nothing to say of what it sends.
    expect(appFace({ ...stake, sends: [] }, said).figures).toEqual([
      { label: "You get", value: "50 aBasUSDC", note: "$50", role: "gets" },
      { label: "Contract", value: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5" },
    ]);
  });

  it("says so where the simulation saw something it can't price, and shows no amount for it", () => {
    const [sent] = stake.sends;
    const unpriced = appFace(
      { ...stake, sends: [{ ...sent!, symbol: "MYST", usd: null }] },
      { ...said, moves: false },
    );
    expect(unpriced.figures[0]).toEqual({
      label: "You send",
      value: "50 MYST",
      note: "Auni can't price it",
      role: "pays",
    });
    // With no price there is no amount: the button names what it does, and the receipt none.
    expect(unpriced.action).toBe("Stake");
    expect(unpriced.receipt.amount).toBeNull();
    expect(JSON.stringify(unpriced)).not.toContain("{amount}");
  });

  it.each(["buy", "sell", "deposit", "move"] as const)("says so in the %s layout too", (layout) => {
    const face = appFace(
      { ...deposit, layout, toChain: "Ethereum", note: "It pays a yield." },
      said,
    );
    expect(face.checks?.unchecked?.says).toBe("It pays a yield.");
  });

  it("says none of it once an app vouches for the transaction, whatever the agent noted", () => {
    const vouched = appFace({ ...stake, vouched: true, note: "Trust me." }, said);
    expect(vouched.checks).toBeUndefined();
    expect(JSON.stringify(vouched)).not.toContain("Trust me.");
  });

  it("fits a card however long the words that came from outside", () => {
    const long = appFace({ ...stake, app: "L".repeat(400), note: "n".repeat(400) }, said);
    expect(cardFaceSchema.safeParse(long).success).toBe(false);
    expect(cardFaceSchema.safeParse(fitted(long)).success).toBe(true);
  });
});

describe("the plain face", () => {
  const plain = (card: Partial<Parameters<typeof plainFace>[0]> & { summary: string }) => {
    const whole = { lines: [], amount: usdc("0"), flow: "in" as const, ...card };
    return fillFace(plainFace(whole), whole.amount);
  };

  it("falls back to core's sentence and its lines, in core's order", () => {
    const content = plain({
      summary: "Approve 0x2222…2222 to spend your USDC",
      lines: [
        { label: "Leaves", value: "0x2222…2222 able to spend your USDC" },
        { label: "Chain", value: "Base" },
        { label: "To", value: "USDC contract (0x8335…2913)" },
      ],
    });
    expect(content.figures.map((figure) => figure.label)).toEqual(["Leaves", "Chain", "To"]);
    expect(content.action).toBe("Make move");
  });

  it("shows what a move gives, gets, costs and lets, as core wrote them", () => {
    const lines = [
      { label: "You give", value: "$10 of USDC on Monad" },
      { label: "You get", value: "$10 in Aave savings" },
      { label: "Costs", value: "$0.40 network fee" },
      { label: "Lets", value: "0x2222…2222 spend your USDC" },
    ];
    const content = plain({
      summary: "Put $10.00 into Aave savings on Monad",
      lines,
      amount: usdc("10000000"),
    });
    expect(content.title).toBe("Put $10.00 into Aave savings on Monad");
    // Its permission is said where every card says one, not among its figures (see withLeaves).
    expect(content.figures).toEqual(lines.slice(0, 3));
    expect(content.leaves).toEqual([{ says: "From now on, it lets 0x2222…2222 spend your USDC." }]);
    expect(content.working).toBe("Putting in $10");
    expect(content.receipt.title).toBe("Put $10.00 into Aave savings on Monad");
  });

  it("says every line of a move's effect, however many, whole", () => {
    const lines = Array.from({ length: 9 }, (_, index) => ({
      label: `You give ${index}`,
      value: "a very long value that runs well past forty characters in all",
    }));
    const content = plain({ summary: "Send it", lines });
    expect(content.figures).toHaveLength(9);
    expect(content.figures[8]).toEqual({
      label: "You give 8",
      value: "a very long value that runs well past forty characters in all",
    });
    expect(cardFaceSchema.safeParse(plainFace({ ...FULL, lines })).success).toBe(true);
  });

  it("reads a close by what it does, with the money it brings back on its receipt", () => {
    const content = plain({
      summary: "Close your xyz:META position",
      lines: [{ label: "Market", value: "xyz:META" }],
      amount: usdc("41200000"),
      flow: "back",
    });
    expect(content.action).toBe("Close");
    expect(content.working).toBe("Closing your xyz:META position");
    expect(content.receipt).toMatchObject({
      title: "Closed your xyz:META position",
      amount: "$41.20 back",
    });
  });

  it("names the cash a bridge moves on its button, as it does what's spent", () => {
    const content = plain({
      summary: "Move $36.55 of USDC from Solana to Monad",
      lines: [
        { label: "From", value: "Solana" },
        { label: "To", value: "Monad" },
      ],
      amount: usdc("36550000"),
      flow: "move",
    });
    expect(content.action).toBe("Move $36.55");
    expect(content.working).toBe("Moving $36.55");
  });

  // A real card drew this sale as "Move $1.95", "to move", over "Arrives about $1.91".
  it("reads a token sold home through a bridge as a sale, by what comes back", () => {
    const lines = [
      { label: "You get, at least", value: "$1.89 on Monad" },
      { label: "Fees", value: "about $0.04" },
    ];
    const content = plain({
      summary: "Sell 1.0254 WPRL on Ethereum for USDC on Monad",
      lines,
      amount: usdc("1910000"),
      flow: "back",
    });
    expect(content.action).toBe("Sell");
    expect(content.figures).toEqual(lines);
    expect(content.receipt).toMatchObject({
      title: "Sold 1.0254 WPRL on Ethereum for USDC on Monad",
      amount: "$1.91 back",
    });
  });

  it("says where the money is once core knows, and nothing came back while nothing has", () => {
    const sale = {
      summary: "Sell your WPRL",
      lines: [],
      amount: usdc("0"),
      flow: "back" as const,
    };
    expect(fillFace(plainFace(sale, "USDC on Monad"), sale.amount).receipt).toEqual({
      title: "Sold your WPRL",
      detail: "Arrives as USDC on Monad",
      amount: null,
    });
    // Its face is written once: when the sale fills, the same face says what it brought back.
    expect(fillFace(plainFace(sale), usdc("3980000")).receipt.amount).toBe("$3.98 back");
  });
});

const FULL = {
  summary: "Put $50 of USDC into Aave on Base",
  lines: [{ label: "You give", value: "$50 of USDC on Base" }],
  details: {},
  amount: usdc("50000000"),
  flow: "in" as const,
};

describe("every face core writes", () => {
  const said = { summary: FULL.summary, moves: true };
  const faces: readonly (readonly [string, CardFace])[] = [
    ["plain", plainFace(FULL)],
    ...(["buy", "sell"] as const).map(
      (side) =>
        [
          `trade ${side}`,
          tradeFace(
            {
              ...stockBuy,
              side,
              selling: "0.27 NVDAx",
              atLeast: "$48.10",
              costs: [
                { label: "network fee", usd: 0.25 },
                { label: "price impact", usd: 0.4 },
              ],
            },
            said,
          ),
        ] as const,
    ),
    [
      "withdrawal",
      withdrawalFace(
        {
          to: "0x1a2B…fa0b",
          network: "Solana",
          arrives: "In seconds",
          fee: "$0.07",
        },
        said,
      ),
    ],
    ...(["buy", "sell", "deposit", "move", null] as const).map(
      (layout) =>
        [
          `app ${layout}`,
          appFace(
            {
              ...deposit,
              layout,
              toChain: "Ethereum",
              gets: [leg, leg],
              price: "$1.318",
              vsMarket: "0.4% worse",
              networkFee: "$0.80",
            },
            said,
          ),
        ] as const,
    ),
  ];

  it.each(faces)("is a face of the one shape: %s", (_, face) => {
    expect(cardFaceSchema.parse(face)).toEqual(face);
  });

  // The dollars on a card are core's own: a face says AMOUNT where they go. Only a title that is
  // the move's own sentence may say dollars, since the card has always shown that sentence.
  it.each(faces)("types no dollar figure into its title or its button: %s", (_, face) => {
    expect(face.action).not.toMatch(/\$\d/u);
    if (face.title !== said.summary) expect(face.title).not.toMatch(/\$\d/u);
  });
});

describe("fitted", () => {
  it("cuts words from outside to the lengths a card takes, and leaves a face that fits alone", () => {
    const face = tradeFace(stockBuy, MOVES);
    expect(fitted(face)).toEqual(face);
    const long = fitted({
      ...face,
      title: "t".repeat(900),
      context: "c".repeat(900),
      pick: { name: "n".repeat(900), tag: "g".repeat(90) },
      receipt: { ...face.receipt, detail: "d".repeat(900) },
    });
    expect(cardFaceSchema.safeParse(long).success).toBe(true);
    expect(long.title).toBe(`${"t".repeat(499)}…`);
  });
});

describe("withFace", () => {
  const preview = {
    summary: "Sell about $0.99 of NVIDIA xStock on Solana",
    effect: { gives: [], gets: [], grants: [] },
  };

  it("tells the face whether its card moves money, as the card's own amount will say", () => {
    const action = (amountUsd: string, details?: Record<string, string>) =>
      withFace({ ...preview, amountUsd, ...(details ? { details } : {}) }, (said) =>
        tradeFace(stockSell, said),
      ).card?.action;
    // A sale spends nothing, and moves what its preview priced coming back.
    expect(action("0", { returnsUsd: "0.99" })).toBe("Sell {amount}");
    expect(action("0")).toBe("Sell Nvidia");
    expect(action("0", { returnsUsd: "0.00" })).toBe("Sell Nvidia");
    expect(action("5.00")).toBe("Sell {amount}");
  });
});

// A plan says what its moves cost in the same words as a lone card, each by its own name.
describe("costFigures", () => {
  it("says each cost by its name, then its dollars, summed across a plan's moves", () => {
    const effects = [
      { gives: [], gets: [], grants: [], costs: [{ label: "price impact", usd: 2.5 }] },
      {
        gives: [],
        gets: [],
        grants: [],
        costs: [
          { label: "network fee", usd: 0.3 },
          { label: "price impact", usd: 0.2 },
        ],
      },
    ];
    expect(costFigures(costsTogether(effects))).toEqual([
      { label: "Price impact", value: "$2.70" },
      { label: "Network fee", value: "$0.30" },
    ]);
    const lone = tradeFace({ ...stockBuy, costs: [{ label: "price impact", usd: 0.25 }] }, MOVES);
    expect(lone.figures).toContainEqual({ label: "Price impact", value: "$0.25" });
  });
});

describe("withLeaves", () => {
  const face = tradeFace(stockBuy, MOVES);

  it("says every permission a move leaves, each whole on its own, whoever wrote its face", () => {
    const granted = withLeaves(face, {
      grants: [
        { lets: "0x1a2b…9f8e spend your USDC", reach: "wallet" },
        {
          lets: "Polymarket's exchanges trade the shares in your Polymarket wallet",
          reach: "venue",
        },
      ],
    });
    expect(granted.leaves).toEqual([
      { says: "From now on, it lets 0x1a2b…9f8e spend your USDC." },
      {
        says: "From now on, it lets Polymarket's exchanges trade the shares in your Polymarket wallet.",
      },
    ]);
    expect(withLeaves(face, { grants: [] })).toBe(face);
  });

  it("never drops or cuts one, however long the tokens' own names make them", () => {
    // Two allowances over tokens whose contracts name themselves at length: once these were one
    // sentence cut at 500 characters, and the second fell off the end. Names are never shortened,
    // since the check before signing compares these words (see assertStillAsShown).
    const names = new Map([
      [TOKEN_A, { symbol: "A".repeat(200), decimals: 18 }],
      [TOKEN_B, { symbol: "B".repeat(200), decimals: 18 }],
    ]);
    const grants = [TOKEN_A, TOKEN_B].map((token) => ({
      lets: grantLabel({ kind: "spend", token, to: SPENDER }, names),
      reach: "wallet" as const,
    }));
    expect(tooMuchToShow({ grants })).toBeNull();
    const card = fitted(withLeaves({ ...face, warning: "W".repeat(500) }, { grants }));
    expect(card.leaves?.map(({ says }) => says)).toEqual([
      `From now on, it lets 0x2222…2222 spend your ${"A".repeat(200)}.`,
      `From now on, it lets 0x2222…2222 spend your ${"B".repeat(200)}.`,
    ]);
    expect(cardFaceSchema.safeParse(card).success).toBe(true);
  });

  it("says an order the owner places too, marked so a lone card leaves it to its figures", () => {
    const stop = {
      lets: "Hyperliquid close your whole BTC long, the part you hold now included, at market if BTC reaches $90,000",
      reach: "venue",
      order: true,
    } as const;
    expect(withLeaves(face, { grants: [stop] }).leaves).toEqual([
      {
        says: "From now on, it lets Hyperliquid close your whole BTC long, the part you hold now included, at market if BTC reaches $90,000.",
        order: true,
      },
    ]);
  });

  it("says what a move with no face of its own leaves apart from its figures", () => {
    const plain = plainFace({
      summary: "Approve the router",
      amount: usdc("0"),
      flow: "in",
      lines: effectLines({
        gives: [],
        gets: [],
        grants: [
          { lets: "0x1a2b…9f8e spend your USDC", reach: "wallet" },
          { lets: "0x1a2b…9f8e spend your WETH", reach: "wallet" },
        ],
      }),
    });
    expect(plain.figures.map(({ label }) => label)).not.toContain("Lets");
    expect(plain.leaves).toEqual([
      { says: "From now on, it lets 0x1a2b…9f8e spend your USDC and 0x1a2b…9f8e spend your WETH." },
    ]);
  });
});

describe("tooMuchToShow", () => {
  const spend = (index: number) => ({
    lets: `0x${String(index).repeat(4)}…${String(index).repeat(4)} spend your USDC`,
    reach: "wallet" as const,
  });
  const few = { grants: [spend(1), spend(2), spend(3)] };

  // A card says every permission its move grants, whole, or there is no card.
  it("refuses a move that leaves more than a card can say whole, and passes one that fits", () => {
    const many = { grants: Array.from({ length: 20 }, (_, index) => spend(index % 10)) };
    expect(tooMuchToShow(many)).toMatch(/^It leaves 20 permissions, more than one card/u);
    expect(tooMuchToShow(few)).toBeNull();
    expect(tooMuchToShow({ grants: [] })).toBeNull();
  });

  // Found in review: a name cut short to fit let two tokens read alike, so the check before
  // signing passed a swapped one. Whole, a name too long for a card gets no card instead.
  it("refuses one permission whose token's name is too long to show whole", () => {
    const names = new Map([[TOKEN_A, { symbol: "A".repeat(500), decimals: 18 }]]);
    const lets = grantLabel({ kind: "spend", token: TOKEN_A, to: SPENDER }, names);
    expect(lets).toContain("A".repeat(500));
    expect(tooMuchToShow({ grants: [{ lets, reach: "wallet" }] })).toMatch(/^It leaves 1 /u);
  });

  // What it measures is the most a card draws: the plain face's one sentence, each leaf in it.
  it("passes exactly what a card draws whole, and one character more is refused", () => {
    const at = (length: number) => ({
      grants: [
        { lets: "x".repeat(length - "From now on, it lets .".length), reach: "wallet" as const },
      ],
    });
    expect(tooMuchToShow(at(500))).toBeNull();
    const plain = plainFace({
      summary: "Approve the router",
      amount: usdc("0"),
      flow: "in",
      lines: effectLines({ gives: [], gets: [], ...at(500) }),
    });
    expect(plain.leaves?.[0]?.says).toHaveLength(500);
    expect(cardFaceSchema.safeParse(fitted(plain)).success).toBe(true);
    expect(tooMuchToShow(at(501))).not.toBeNull();
  });
});
