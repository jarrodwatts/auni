import { randomUUID } from "node:crypto";

import { NETWORKS, type CardWire } from "@auni/shared";
import { asc, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, arrivals, fills, jobs, messages, threads, otherTokens } from "../db/schema.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import { listingsOf } from "../test/recognised.ts";
import { stubRecipe } from "../test/recipe.ts";
import { executeAction } from "./actions.ts";
import { recordArrivals } from "./arrivals.ts";
import { listOtherTokens, seeTokens, sortTokens } from "./buckets.ts";
import { tokenPrices } from "./history.ts";
import { madeUsd, walletFlows } from "./made.ts";
import { howItCame } from "./how-it-came.ts";
import { foundJob } from "./news.ts";
import { readOtherTokens, tellRecognised } from "./other-tokens.ts";
import { readTokens } from "./chain-holdings.ts";
import type { Recipe } from "./recipe.ts";
import { listings } from "./recognised.ts";
import { moneyTools } from "./tools.ts";
import { readTransfers } from "./transfers.ts";

const SENDER = "0x2222222222222222222222222222222222222222";
/** Sent unasked, and on no list until it is. */
const { XYZ } = vi.hoisted(() => ({ XYZ: "0x5555555555555555555555555555555555555555" }));
const SPAM = "0x3333333333333333333333333333333333333333";
const LINK = "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196";

vi.mock("./wallets.ts", async (o) => ({
  ...(await import("../test/chain.ts")).wallets(await o()),
  signerFor: async () => ({}),
}));
// The move a test runs, in place of its tool's recipe, so no venue is called.
const running = vi.hoisted(() => ({ recipe: undefined as Recipe | undefined }));
vi.mock("./recipes/index.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./recipes/index.ts")>();
  return {
    ...original,
    recipeForTool: (tool: string) => running.recipe ?? original.recipeForTool(tool),
  };
});
vi.mock("./recognised.ts", async (o) => (await import("../test/chain.ts")).recognised(await o()));
// The wallet holds `xyzHeld` XYZ and 5 of the spam, which a pool its sender seeded prices at $2,
// as of block `readAt`.
let xyzHeld = 1_000n;
let readAt = 100;
/** Ether in their wallet on a chain whose own coin is Ether. */
let ethHeld = 0n;
vi.mock("./chains.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  evmClient: () => ({
    getBlockNumber: async () => BigInt(readAt),
    getBalance: async () => ethHeld,
  }),
}));
vi.mock("./chain-holdings.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readTokens: vi.fn(async (_client: unknown, _owner: string, tokens: string[]) =>
    tokens.map((token) => ({
      token,
      balance: (token === XYZ ? xyzHeld : 5n) * 10n ** 18n,
      decimals: 18,
      symbol: "Claim your airdrop at xyz-claim.com",
    })),
  ),
}));
// XYZ came in by a bridge and part of it went on to Polymarket.
vi.mock("./how-it-came.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  howItCame: vi.fn(async () => [
    { at: new Date("2026-09-28T03:00:00Z"), amount: "-500", who: "their Polymarket wallet" },
    { at: new Date("2026-08-23T19:00:00Z"), amount: "1500", who: "an Across bridge" },
  ]),
}));
vi.mock("./transfers.ts", async (o) => (await import("../test/chain.ts")).transfers(await o()));
// XYZ was $0.04 when it moved, as now; each test says what else is priced now.
vi.mock("./history.ts", async (o) =>
  (await import("../test/chain.ts")).history(await o(), {
    [`base:${XYZ}`]: { price: 0.04 },
  }),
);

beforeEach(async () => {
  await wipe(threads, messages, otherTokens, actions, fills, arrivals);
  xyzHeld = 1_000n;
  readAt = 100;
  ethHeld = 0n;
  vi.mocked(listings).mockImplementation(listingsOf({ [`base:${LINK}`]: "LINK" }));
  vi.mocked(tokenPrices).mockResolvedValue({
    prices: new Map([
      [`base:${XYZ}`, { price: 0.04 }],
      [`base:${SPAM}`, { price: 2 }],
    ]),
    complete: true,
  });
  vi.mocked(readTokens).mockClear();
  // Back to the story above, whatever a test told it.
  vi.mocked(howItCame).mockReset();
});

/** Tokens seen coming into their wallet on Base: XYZ, the spam, and LINK, which the lists know. */
async function seen() {
  await seeTokens(db, "base", [XYZ, SPAM, LINK]);
}

/** One of the agent's tools, called with `input`; what it said. */
async function tool(name: string, input = {}) {
  const thread = await insertThread();
  const found = moneyTools({ threadId: thread.id }).find((each) => each.name === name);
  const outcome = await found!.handler(input);
  return (outcome.content[0] as { text: string }).text;
}

describe("Other tokens", () => {
  it("are listed by address, with what's held and what it may be worth, read only when asked", async () => {
    await seen();
    expect(await listOtherTokens()).toEqual([
      expect.objectContaining({ chain: "base", instrument: SPAM }),
      expect.objectContaining({ chain: "base", instrument: XYZ }),
    ]);
    expect(readTokens).not.toHaveBeenCalled();

    expect(await readOtherTokens()).toEqual({
      tokens: [
        { network: "base", address: SPAM, amount: "5", usdValue: "10.00" },
        { network: "base", address: XYZ, amount: "1000", usdValue: "40.00" },
      ],
    });
  });

  it("are listed to the agent by address and amount alone, never a name or a value", async () => {
    await seen();
    vi.mocked(tokenPrices).mockClear();
    const said = await tool("list_other_tokens");
    expect(JSON.parse(said)).toEqual({
      tokens: [
        { network: "base", address: SPAM, amount: "5" },
        { network: "base", address: XYZ, amount: "1000" },
      ],
    });
    expect(said).not.toContain("airdrop");
    // What it would be worth isn't said, so isn't asked.
    expect(tokenPrices).not.toHaveBeenCalled();
  });

  it("become theirs when they add one, by address on its network", async () => {
    await seen();
    expect(await tool("add_token", { network: "base", address: "0xnope" })).toContain(
      "isn't a token address",
    );
    expect(
      await tool("add_token", {
        network: "base",
        address: XYZ.toUpperCase().replace("0X", "0x"),
      }),
    ).toContain("Added");

    expect((await listOtherTokens()).map(({ instrument }) => instrument)).toEqual([SPAM]);
    expect((await sortTokens("base", [XYZ])).get(`base:${XYZ}`)?.bucket).toBe("yours");
    // Its worth as they add it is money put in, so adding it makes nothing.
    expect((await walletFlows()).map(({ usd }) => usd)).toEqual([40]);
    // Adding it again changes nothing.
    await tool("add_token", { network: "base", address: XYZ });
    expect((await walletFlows()).map(({ usd }) => usd)).toEqual([40]);
  });

  it("put nothing in when one already counts, bought or their cash, as what's in it was counted as it came", async () => {
    const bought = await insertAction({ status: "done" });
    await db.insert(fills).values({
      actionId: bought.id,
      chain: "base",
      instrument: XYZ,
      side: "buy",
      quantity: "1000",
      usdValue: "25.00",
    });
    const usdc = NETWORKS.base.usdc!;
    vi.mocked(tokenPrices).mockResolvedValue({
      prices: new Map([
        [`base:${XYZ}`, { price: 0.04 }],
        [`base:${usdc.toLowerCase()}`, { price: 1 }],
      ]),
      complete: true,
    });
    const before = await walletFlows();
    for (const address of [XYZ, usdc])
      expect(await tool("add_token", { network: "base", address })).toContain("Added");
    expect(await walletFlows()).toEqual(before);
    // Nothing to value, so nothing read.
    expect(readTokens).not.toHaveBeenCalled();
  });

  it("aren't added while what they're worth can't be read, lest their worth show as made", async () => {
    await seen();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(tokenPrices).mockResolvedValue({ prices: new Map(), complete: false });
    expect(await tool("add_token", { network: "base", address: XYZ })).toContain("Not added");
    expect((await listOtherTokens()).map(({ instrument }) => instrument)).toEqual([SPAM, XYZ]);
    expect(await walletFlows()).toEqual([]);
  });
});

describe("tellRecognised", () => {
  /** The cards Auni left in their chats, oldest first. */
  async function cards(): Promise<CardWire[]> {
    const rows = await db.select().from(messages).orderBy(asc(messages.createdAt));
    return rows.flatMap((row) =>
      (row.parts as { data?: { cards: CardWire[] } }[]).flatMap((part) => part.data?.cards ?? []),
    );
  }

  /** What Auni was woken to tell, in which thread, oldest first, once each tell queued runs (see foundJob). */
  async function wakes() {
    for (const job of await queued("found")) {
      const run = {
        id: randomUUID(),
        createdAt: new Date(),
        attempts: 1,
        signal: new AbortController().signal,
      };
      await foundJob.run(foundJob.kind.data.parse(job.data), run);
    }
    await db.delete(jobs).where(eq(jobs.kind, "found"));
    return (await queued("turn")).map(({ data }) => data as { threadId: string; reason: string });
  }

  it("wakes their latest chat once when a token they were sent comes to be listed, with how it got there", async () => {
    await seen();
    const chat = await insertThread();
    await db.insert(messages).values({ threadId: chat.id, role: "user", parts: [] });
    await tellRecognised();
    expect(await wakes()).toEqual([]);

    // CoinGecko lists XYZ.
    vi.mocked(listings).mockImplementation(
      listingsOf({ [`base:${LINK}`]: "LINK", [`base:${XYZ}`]: "XYZ" }),
    );
    await tellRecognised();
    await tellRecognised();
    expect(await wakes()).toEqual([{ threadId: chat.id, reason: expect.any(String) }]);
    const { reason } = (await wakes())[0]!;
    expect(reason).toContain(`1000 XYZ on Base (token ${XYZ}), worth $40 now`);
    expect(reason).toContain("Sep 28, 2026: 500 out to their Polymarket wallet");
    expect(reason).toContain("Aug 23, 2026: 1500 in from an Across bridge");
    expect(reason).toContain("This isn't money arriving");
    // Nothing moved, so no card says it did.
    expect(await cards()).toEqual([]);
    // No longer Other, and read from now on.
    expect((await listOtherTokens()).map(({ instrument }) => instrument)).toEqual([SPAM]);
    // Theirs from now, counted at its worth now as money put in, whatever lists say later.
    expect((await sortTokens("base", [XYZ])).get(`base:${XYZ}`)?.bucket).toBe("yours");
    expect((await walletFlows()).map(({ usd }) => usd)).toEqual([40]);
  });

  it("wakes the main conversation, there before the wake, for someone with none", async () => {
    await seen();
    vi.mocked(listings).mockImplementation(listingsOf({ [`base:${XYZ}`]: "XYZ" }));
    await tellRecognised();
    const woken = await wakes();
    const chats = await db.select().from(threads);
    expect(chats).toEqual([expect.objectContaining({ title: "Auni" })]);
    expect(woken).toEqual([{ threadId: chats[0]!.id, reason: expect.any(String) }]);
  });

  it("tells every one of many listed at once, whole, a few to a wake", async () => {
    const many = Array.from({ length: 9 }, (_, at) => `0x${String(at + 10).repeat(20)}`);
    await seeTokens(db, "base", many);
    vi.mocked(listings).mockImplementation(
      listingsOf(Object.fromEntries(many.map((token, at) => [`base:${token}`, `TOKEN${at}`]))),
    );
    vi.mocked(tokenPrices).mockResolvedValue({
      prices: new Map(many.map((token) => [`base:${token}`, { price: 2 }])),
      complete: true,
    });
    // Each came and went a dozen times, from someone with no name Auni knows.
    vi.mocked(howItCame).mockResolvedValue(
      Array.from({ length: 12 }, (_, at) => ({
        at: new Date(Date.UTC(2026, 8, at + 1)),
        amount: "-123456.123456",
        who: "0x1a2b3c…9f8e",
      })),
    );
    await tellRecognised();
    const reasons = (await wakes()).map(({ reason }) => reason);
    expect(reasons).toHaveLength(2);
    for (const reason of reasons) expect(reason.length).toBeLessThanOrEqual(4_000);
    for (const [at, token] of many.entries())
      expect(reasons.join()).toContain(`5 TOKEN${at} on Base (token ${token}), worth $10 now`);
  });

  it("still tells one whose story the chain won't give, saying so", async () => {
    await seen();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(howItCame).mockRejectedValueOnce(new Error("the RPC is down"));
    vi.mocked(listings).mockImplementation(listingsOf({ [`base:${XYZ}`]: "XYZ" }));
    await tellRecognised();
    expect(await wakes()).toHaveLength(1);
    expect((await wakes())[0]!.reason).toContain(`"howItCame":"couldn't be read"`);
  });

  describe("as a deposit of it lands, whichever is recorded first", () => {
    /** 500 XYZ, $20, sent to them in tx `hash`, in `block`, and recorded. */
    async function land(hash: string, block: number) {
      vi.mocked(readTransfers).mockResolvedValue({
        at: new Date(),
        block,
        transfers: [
          {
            position: "log:0",
            instrument: XYZ,
            decimals: 18,
            baseUnits: 500n * 10n ** 18n,
            counterparty: SENDER,
          },
        ],
        walletSigned: false,
        closedAccounts: [],
      });
      await recordArrivals("base", hash);
    }

    /** What they put in, smallest first. */
    async function putIn() {
      return (await walletFlows()).map(({ usd }) => usd).toSorted((a, b) => a - b);
    }

    beforeEach(() => {
      // CoinGecko lists XYZ, and all they hold of it is the 500 that land in block 100.
      vi.mocked(listings).mockImplementation(
        listingsOf({ [`base:${LINK}`]: "LINK", [`base:${XYZ}`]: "XYZ" }),
      );
      xyzHeld = 500n;
    });

    it("counts it once when its worth, read at the deposit's block, is kept first", async () => {
      await seen();
      await tellRecognised();
      await land("0xin", 100);
      expect(await putIn()).toEqual([20]);
      // What lands after the block its worth was read at isn't in that worth, so it counts.
      await land("0xlater", 101);
      expect(await putIn()).toEqual([20, 20]);
    });

    it("counts it once when the deposit is recorded first", async () => {
      await seen();
      await land("0xin", 100);
      await tellRecognised();
      expect(await putIn()).toEqual([20]);
    });

    describe("beside the 1,000 XYZ, $40, sent them unasked before", () => {
      beforeEach(() => {
        xyzHeld = 1_500n;
      });

      /** What their XYZ, at $0.04, made, with what they put in. */
      async function made() {
        return madeUsd(Number(xyzHeld) * 0.04, 0, await walletFlows());
      }

      it("counts what they held and what landed once each when a deposit they said they'd send is recorded first", async () => {
        await seen();
        // The agent named XYZ by its address as what they'd send, before any list knew it.
        vi.mocked(listings).mockImplementation(listingsOf({ [`base:${LINK}`]: "LINK" }));
        await insertThread({ expectedTokens: [`base:${XYZ}`] });
        await land("0xin", 100);
        // The $40 they held and the $20 that landed, read at the deposit's block, put in once.
        expect(await putIn()).toEqual([60]);
        expect(await made()).toBe("0.00");

        // CoinGecko lists it: it counts already, and its deposit was told on their card.
        vi.mocked(listings).mockImplementation(
          listingsOf({ [`base:${LINK}`]: "LINK", [`base:${XYZ}`]: "XYZ" }),
        );
        await tellRecognised();
        expect(await putIn()).toEqual([60]);
        expect(await made()).toBe("0.00");
        expect(await wakes()).toEqual([]);

        // What lands after counts as it lands.
        xyzHeld = 2_000n;
        await land("0xlater", 101);
        expect(await putIn()).toEqual([20, 60]);
        expect(await made()).toBe("0.00");
      });

      it("leaves it to the deposit's card when it lands as it comes to be listed", async () => {
        await seen();
        await land("0xin", 100);
        await tellRecognised();
        expect(await putIn()).toEqual([60]);
        expect(await made()).toBe("0.00");
        // Money moved, which its own card tells; a wake saying nothing moved would be wrong.
        expect(await wakes()).toEqual([]);
      });
    });
  });

  it("tells nothing of one worth under a cent, and never asks again", async () => {
    await seen();
    vi.mocked(listings).mockImplementation(listingsOf({ [`base:${SPAM}`]: "SPAM" }));
    vi.mocked(tokenPrices).mockResolvedValue({
      prices: new Map([[`base:${SPAM}`, { price: 0.0001 }]]),
      complete: true,
    });
    await tellRecognised();
    await tellRecognised();
    expect(await wakes()).toEqual([]);
    expect(howItCame).not.toHaveBeenCalled();
    expect(readTokens).toHaveBeenCalledOnce();
  });
});

describe("bought by Auni", () => {
  /** Auni buys them 500 XYZ for $20 on `chain`, which land in block 101. */
  async function buyXyz(chain: "base" | "ethereum" = "base") {
    running.recipe = stubRecipe({
      tool: "evm_swap",
      about: () => ({ kind: "token", chain, mint: XYZ, stock: false, buysUsd: 20 }),
      execute: async () => {
        xyzHeld += 500n;
        readAt = 101;
        return {
          txs: [{ chain, hash: "0xbuy" }],
          fills: [{ chain, instrument: XYZ, side: "buy", quantity: "500", usdValue: "20" }],
        };
      },
    });
    const { id } = await insertAction({
      tool: "evm_swap",
      input: { chain, sellToken: "USDC", buyToken: XYZ, amount: "20" },
      amountUsd: "20",
    });
    try {
      expect(await executeAction(id)).toMatchObject({ status: "done" });
    } finally {
      running.recipe = undefined;
    }
  }

  it("counts what they held of it while it was Other as put in, and only what it bought as bought", async () => {
    await seen();
    await buyXyz();
    // The 1,000 they held, $40 read before the buy, and the $20 it cost: the 1,500 made nothing.
    const flows = await walletFlows();
    expect(flows.map(({ usd }) => usd)).toEqual([40, 20]);
    expect(madeUsd(1_500 * 0.04, 0, flows)).toBe("0.00");
    expect((await listOtherTokens()).map(({ instrument }) => instrument)).toEqual([SPAM]);
  });

  it("counts what a wallet held of one it never saw arrive as put in, as a wallet brought in holds", async () => {
    await buyXyz();
    const flows = await walletFlows();
    expect(flows.map(({ usd }) => usd)).toEqual([40, 20]);
    expect(madeUsd(1_500 * 0.04, 0, flows)).toBe("0.00");
  });

  it("counts the coin of a chain it begins to read as put in, once", async () => {
    ethHeld = 10n ** 17n;
    vi.mocked(tokenPrices).mockResolvedValue({
      prices: new Map([
        [`ethereum:${XYZ}`, { price: 0.04 }],
        [NETWORKS.ethereum.coin.priceId, { price: 3_000 }],
      ]),
      complete: true,
    });
    // 0.1 ETH, $300, held on Ethereum before Auni read it; then the 1,000 XYZ, $40; then the buy.
    await buyXyz("ethereum");
    expect((await walletFlows()).map(({ usd }) => usd).toSorted((a, b) => a - b)).toEqual([
      20, 40, 300,
    ]);
    // A second move there finds Ether read since the first, and puts nothing more in.
    await buyXyz("ethereum");
    expect((await walletFlows()).map(({ usd }) => usd).toSorted((a, b) => a - b)).toEqual([
      20, 20, 40, 300,
    ]);
  });

  it("puts nothing in for one their wallet held none of", async () => {
    xyzHeld = 0n;
    await buyXyz();
    // Only the buy counts, and a token held none of keeps no row: what it gets counts as it comes.
    expect((await walletFlows()).map(({ usd }) => usd)).toEqual([20]);
    expect(await db.select().from(otherTokens)).toEqual([]);
  });
});
