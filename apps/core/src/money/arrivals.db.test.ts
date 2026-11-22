import { NETWORKS, type NetworkKey } from "@auni/shared";
import { asc, eq } from "drizzle-orm";
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { savingsTokens } from "../apps/registry.ts";
import { actions, arrivalCursors, arrivals, fills, threads, otherTokens } from "../db/schema.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import { listingsOf } from "../test/recognised.ts";
import { fakeWallet } from "../test/wallet.ts";
import { depositWire, NotKnownYet, recentDeposits, recordArrivals } from "./arrivals.ts";
import { listOtherTokens, seenTokens, seeTokens, sortTokens } from "./buckets.ts";
import { publicClient, solanaRpc } from "./chains.ts";
import { shortAddress } from "./format.ts";
import { tokenPrices } from "./history.ts";
import { madeUsd, walletFlows } from "./made.ts";
import { payInStanding, type PayInStanding } from "./pay-in.ts";
import { readPortfolio } from "./portfolio.ts";
import { solanaTokens } from "./chain-holdings.ts";
import { listings } from "./recognised.ts";
import { LANDING_WINDOW_MS } from "./record.ts";
import { sweepNetwork } from "./sweep.ts";
import { readTransfers, type Transfer } from "./transfers.ts";

const SENDER = "0x2222222222222222222222222222222222222222";
const SPAM = "0x3333333333333333333333333333333333333333";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const PEPE = "0x6982508145454ce325ddbe47a25d4ec3d2311933";
const BASE_USDC = NETWORKS.base.usdc.toLowerCase();

vi.mock("./wallets.ts", async (o) =>
  (await import("../test/chain.ts")).wallets(await o(), SOLANA_WALLET),
);
vi.mock("./chains.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./chains.ts")>();
  return { ...original, solanaRpc: vi.fn(original.solanaRpc) };
});
vi.mock("./transfers.ts", async (o) => (await import("../test/chain.ts")).transfers(await o()));
vi.mock("./chain-holdings.ts", async (o) => (await import("../test/chain.ts")).holdings(await o()));
// The lists recognise the network's coins and cash, and LINK, PEPE, the xStock and BONK; never spam.
vi.mock("./recognised.ts", async (o) => (await import("../test/chain.ts")).recognised(await o()));
// ETH was $2,600 when it moved, a share of the xStock $100, LINK $15 and BONK $0.00002, each
// priced now as then; the spam token has no price.
const { SOLANA_WALLET, XSTOCK, LINK, PRICES } = vi.hoisted(() => {
  const XSTOCK = "0x1aad217b8f78dba5e6693460e8470f8b1a3977f3";
  const LINK = "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196";
  return {
    SOLANA_WALLET: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T",
    XSTOCK,
    LINK,
    PRICES: {
      "coingecko:ethereum": { price: 2_600 },
      [`base:${XSTOCK}`]: { price: 100 },
      [`base:${LINK}`]: { price: 15 },
      "solana:DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": { price: 0.00002 },
    },
  };
});
vi.mock("./history.ts", async (o) => (await import("../test/chain.ts")).history(await o(), PRICES));
// The pay-in service, asked where an order stands only by the tests of a fee-coin purchase.
vi.mock(import("./pay-in.ts"), async (original) => ({
  ...(await original()),
  payInStanding: vi.fn(),
}));

let wallet: ReturnType<typeof fakeWallet>;

beforeEach(async () => {
  wallet = fakeWallet();
  vi.mocked(payInStanding).mockReset();
  await wipe(actions, threads, arrivals, arrivalCursors, fills, otherTokens);
  vi.mocked(listings).mockImplementation(
    listingsOf({
      [`base:${LINK}`]: "LINK",
      [`base:${PEPE}`]: "PEPE",
      [`base:${XSTOCK}`]: "STRCx",
      [`solana:${BONK}`.toLowerCase()]: "Bonk",
    }),
  );
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const daysAgo = (days: number) => minutesAgo(days * 24 * 60);

function transfer(fields: Partial<Transfer>): Transfer {
  return {
    position: "log:1",
    instrument: BASE_USDC,
    decimals: 6,
    baseUnits: 5_000_000n,
    counterparty: SENDER,
    ...fields,
  };
}

/** The chain shows `transfers` in tx `hash`, and the recorder is told of it. */
async function hint(
  chain: NetworkKey,
  hash: string,
  transfers: Transfer[],
  at = minutesAgo(1),
  walletSigned = false,
) {
  vi.mocked(readTransfers).mockResolvedValue({
    at,
    block: wallet.move(chain, hash, transfers),
    transfers,
    walletSigned,
    closedAccounts: [],
  });
  await recordArrivals(chain, hash);
}

const recorded = () =>
  db
    .select({
      kind: arrivals.kind,
      usdValue: arrivals.usdValue,
      actionId: arrivals.actionId,
      txHash: arrivals.txHash,
    })
    .from(arrivals)
    .orderBy(asc(arrivals.at), asc(arrivals.position));

const wakes = () => queued("turn");
/** A reading asked for: one a person, however often it's asked, as readings debounce. */
const readingsAsked = () => queued("reading");

describe("recordArrivals", () => {
  it("tells a deposit of USDC and of ETH apart from Auni's own move, and wakes the wait once", async () => {
    const waiting = await insertThread({ awaitingDepositSince: minutesAgo(5) });
    const own = await insertAction({
      status: "done",
      startedAt: minutesAgo(10),
      txs: [{ chain: "base", hash: "0xOWN" }],
    });

    // Its own swap sent USDC out and got ETH back: neither is money from outside.
    await hint(
      "base",
      "0xown",
      [
        transfer({ baseUnits: -5_000_000n }),
        transfer({ position: "call:2", instrument: "native", decimals: 18, baseUnits: 10n ** 15n }),
      ],
      minutesAgo(9),
    );
    await hint("base", "0xusdc", [transfer({})]);
    const eth = transfer({
      position: "call:0",
      instrument: "native",
      decimals: 18,
      baseUnits: 81n * 10n ** 15n,
    });
    await hint("base", "0xeth", [eth]);
    // Replayed, as a sweep's overlap and a wallet's redelivery do: nothing twice.
    await hint("base", "0xeth", [eth]);

    expect(await recorded()).toEqual([
      { kind: "own_move", usdValue: "2.60", actionId: own.id, txHash: "0xown" },
      { kind: "own_move", usdValue: "-5.00", actionId: own.id, txHash: "0xown" },
      expect.objectContaining({ kind: "deposit", usdValue: "5.00", actionId: null }),
      expect.objectContaining({ kind: "deposit", usdValue: "210.60", actionId: null }),
    ]);
    expect(await wakes()).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ threadId: waiting.id }) }),
    ]);
    // Asked for by the deposits; the action asked for its own when it finished.
    expect(await readingsAsked()).toHaveLength(1);
  });

  it("knows a move landing, a payout and money sent out, and records an Other token only as seen", async () => {
    await insertThread({ awaitingDepositSince: minutesAgo(5) });
    const withdrawal = await insertAction({
      tool: "hyperliquid_withdraw",
      phase: "landing",
      startedAt: minutesAgo(3),
      run: { lands: "$9.00 on Arbitrum", landsUnits: "9000000" },
    });
    const arbitrumUsdc = NETWORKS.arbitrum.usdc.toLowerCase();

    await hint("arbitrum", "0xland", [
      transfer({ instrument: arbitrumUsdc, baseUnits: 9_000_000n }),
    ]);
    await hint("base", "0xaave", [
      transfer({ counterparty: savingsTokens("base")[0]!.token.toLowerCase() }),
    ]);
    await hint("base", "0xout", [
      transfer({ instrument: "native", decimals: 18, baseUnits: -(10n ** 16n) }),
    ]);
    // A token no list knows is Other: never recorded or told, however it may be priced.
    await hint("base", "0xspam", [transfer({ instrument: SPAM, decimals: 18 })]);
    await hint("base", "0xspam2", [transfer({ instrument: SPAM, decimals: 18 })]);

    expect(await recorded()).toEqual([
      expect.objectContaining({ kind: "landing", usdValue: "9.00", actionId: withdrawal.id }),
      expect.objectContaining({ kind: "payout", usdValue: "5.00" }),
      expect.objectContaining({ kind: "external_out", usdValue: "-26.00" }),
    ]);
    // Its one row, however often it comes.
    expect(await seenTokens()).toEqual([{ chain: "base", instrument: SPAM }]);
    // Nothing woke the wait: a landing is the move's own, and a payout isn't money they sent in.
    expect(await wakes()).toEqual([]);
    // The payout and the money sent out asked for a reading; the spam asked none.
    expect(await readingsAsked()).toHaveLength(1);
  });

  it("counts a token that landed counted from then on, whatever a list says of it later", async () => {
    const link = (hash: string) =>
      hint("base", hash, [transfer({ instrument: LINK, decimals: 18, baseUnits: 10n ** 18n })]);
    await link("0xlink");
    // CoinGecko drops LINK: its deposit still counts as money put in, so LINK still counts too.
    vi.mocked(listings).mockImplementation(listingsOf({}));
    expect((await sortTokens("base", [LINK])).get(`base:${LINK}`)?.bucket).toBe("yours");
    await link("0xmore");
    expect(await recorded()).toEqual([
      expect.objectContaining({ kind: "deposit", usdValue: "15.00", txHash: "0xlink" }),
      expect.objectContaining({ kind: "deposit", usdValue: "15.00", txHash: "0xmore" }),
    ]);
    expect(await listOtherTokens()).toEqual([]);
  });

  it("wakes nothing for less than a cent, as address poisoning sends, and wakes for a cent or more", async () => {
    await insertThread({ awaitingDepositSince: minutesAgo(5) });
    await hint("base", "0xdust", [
      transfer({ baseUnits: 1n }),
      transfer({ position: "call:0", instrument: "native", decimals: 18, baseUnits: 1_000n }),
    ]);
    expect((await recorded()).map((row) => row.usdValue)).toEqual(["0.00", "0.00"]);
    expect(await wakes()).toEqual([]);
    expect(await readingsAsked()).toEqual([]);

    // A cent is the least the app shows, so it is told like any deposit.
    await hint("base", "0xcent", [transfer({ baseUnits: 10_000n })]);
    expect(await wakes()).toHaveLength(1);
    expect(await readingsAsked()).toHaveLength(1);
  });

  it("knows a bridge's landing by the fill it recorded, and the same coin from an exchange as a deposit", async () => {
    // A bridge to Base still waiting on Across's word that its relayer filled.
    const bridge = await insertAction({
      tool: "bridge_usdc",
      input: { from_chain: "arbitrum", to_chain: "base", amount: "5" },
      phase: "landing",
      run: { lands: "$5.00 on Base" },
      startedAt: minutesAgo(2),
    });

    // Until it says which transaction delivered it, any USDC on Base may be that one.
    await expect(hint("base", "0xexchange", [transfer({})])).rejects.toThrow("not recorded yet");
    await expect(hint("base", "0xfill", [transfer({})])).rejects.toThrow("not recorded yet");
    // ETH on Base is nothing it delivers.
    await hint("base", "0xeth", [
      transfer({ position: "call:0", instrument: "native", decimals: 18, baseUnits: 10n ** 15n }),
    ]);

    const waiting = await insertThread({ awaitingDepositSince: minutesAgo(5) });
    await db
      .update(actions)
      .set({ run: { ...bridge.run, delivered: "0xFILL" } })
      .where(eq(actions.id, bridge.id));
    await hint("base", "0xexchange", [transfer({})]);
    await hint("base", "0xfill", [transfer({})]);
    expect(await recorded()).toEqual([
      expect.objectContaining({ kind: "deposit", txHash: "0xeth" }),
      expect.objectContaining({ kind: "deposit", actionId: null, txHash: "0xexchange" }),
      expect.objectContaining({ kind: "landing", actionId: bridge.id, txHash: "0xfill" }),
    ]);
    // The exchange's USDC is money put in, and wakes the wait.
    expect(await wakes()).toEqual([
      expect.objectContaining({
        data: { threadId: waiting.id, reason: expect.stringContaining("tx 0xexchange") },
      }),
    ]);
  });

  it("waits on no move that is stuck, or began after the money moved", async () => {
    const bridge = { tool: "bridge_usdc", input: { from_chain: "arbitrum", to_chain: "base" } };
    // Running past STUCK_AFTER_MS without saying what delivered it: it never will.
    await insertAction({ ...bridge, startedAt: minutesAgo(31) });
    await hint("base", "0xstuck", [transfer({})]);
    await insertAction({ ...bridge, startedAt: minutesAgo(1) });
    await hint("base", "0xbefore", [transfer({})], minutesAgo(2));
    expect(await recorded()).toEqual([
      expect.objectContaining({ kind: "deposit", txHash: "0xbefore" }),
      expect.objectContaining({ kind: "deposit", txHash: "0xstuck" }),
    ]);
  });

  it("waits on a move on its way through its landing window, for what it delivers or gives back", async () => {
    const arbitrumUsdc = NETWORKS.arbitrum.usdc.toLowerCase();
    // Sent from Arbitrum two hours ago and not landed yet: Across may fill it late, or refund it.
    const bridge = await insertAction({
      tool: "bridge_usdc",
      input: { from_chain: "arbitrum", to_chain: "base", amount: "5" },
      phase: "landing",
      run: { lands: "$5.00 on Base" },
      startedAt: minutesAgo(120),
      txs: [{ chain: "arbitrum", hash: "0xdeposit" }],
    });
    const refund = () => hint("arbitrum", "0xrefund", [transfer({ instrument: arbitrumUsdc })]);
    // The sweep reads the refund before the landing check names it: it waits.
    await expect(refund()).rejects.toThrow(NotKnownYet);
    await expect(hint("base", "0xlate", [transfer({})])).rejects.toThrow(NotKnownYet);
    await db
      .update(actions)
      .set({ status: "done", phase: null, run: { ...bridge.run, delivered: "0xREFUND" } })
      .where(eq(actions.id, bridge.id));
    await refund();
    await hint("base", "0xlate", [transfer({})]);
    expect(await recorded()).toEqual([
      expect.objectContaining({ kind: "landing", actionId: bridge.id, txHash: "0xrefund" }),
      expect.objectContaining({ kind: "deposit", actionId: null, txHash: "0xlate" }),
    ]);
  });

  it("waits on no move whose landing window has passed, as it finishes saying so", async () => {
    await insertAction({
      tool: "bridge_usdc",
      input: { from_chain: "arbitrum", to_chain: "base", amount: "5" },
      phase: "landing",
      run: { lands: "$5.00 on Base" },
      startedAt: new Date(Date.now() - LANDING_WINDOW_MS - 60_000),
      txs: [{ chain: "arbitrum", hash: "0xdeposit" }],
    });
    await hint("base", "0xlate", [transfer({})]);
    expect(await recorded()).toEqual([expect.objectContaining({ kind: "deposit" })]);
  });

  it("knows a maker's payment by the exact amount the move recorded, and nothing it doesn't deliver", async () => {
    // A sale whose maker paid exactly 5 USDC, from the maker's own transaction.
    const sale = await insertAction({
      tool: "stock_trade",
      input: { side: "sell", stock: "TSLA" },
      details: { chain: "base", mint: PEPE },
      run: { landsUnits: "5000000" },
      status: "done",
      startedAt: minutesAgo(2),
    });

    await hint("base", "0xmaker", [transfer({})]);
    await hint("base", "0xother", [transfer({ baseUnits: 5_000_001n })]);
    // A sale delivers cash, never more of what it sold.
    await hint("base", "0xpepe", [transfer({ instrument: PEPE, baseUnits: 5_000_000n })]);
    expect(await recorded()).toEqual([
      expect.objectContaining({ kind: "landing", actionId: sale.id, txHash: "0xmaker" }),
      expect.objectContaining({ kind: "deposit", txHash: "0xother" }),
      expect.objectContaining({ kind: "deposit", txHash: "0xpepe" }),
    ]);
  });

  it("waits on a send of Auni's that the wallet hasn't named yet, which this may be", async () => {
    const buy = await insertAction({
      startedAt: minutesAgo(1),
      txs: [{ chain: "base", walletTxId: "p1" }],
    });
    const eth = transfer({ instrument: "native", decimals: 18, baseUnits: 10n ** 15n });
    await expect(hint("base", "0xbuy", [eth])).rejects.toThrow("not named yet");

    await db.update(actions).set({
      txs: [
        { chain: "base", walletTxId: "p1" },
        { chain: "base", walletTxId: "p1", hash: "0xbuy" },
      ],
    });
    await hint("base", "0xbuy", [eth]);
    expect(await recorded()).toEqual([
      expect.objectContaining({ kind: "own_move", actionId: buy.id }),
    ]);
  });

  it("waits on money leaving while a move of theirs runs, though nothing names its send yet", async () => {
    // Polymarket's relayer sent the pull the wallet signed for, before the buy kept anything of it.
    const buy = await insertAction({
      tool: "polymarket_order",
      startedAt: minutesAgo(1),
      txs: [],
    });
    const usdc = NETWORKS.polygon.usdc;
    const pull = transfer({ position: usdc, instrument: usdc, baseUnits: -9_305_737n });
    await expect(hint("polygon", "0xpull", [pull])).rejects.toThrow(NotKnownYet);
    expect(await recorded()).toEqual([]);

    await db.update(actions).set({
      status: "done",
      phase: null,
      txs: [{ chain: "polygon", relayerId: "r1", setup: true, hash: "0xpull" }],
    });
    await hint("polygon", "0xpull", [pull]);
    expect(await recorded()).toEqual([
      expect.objectContaining({ kind: "own_move", actionId: buy.id }),
    ]);
  });

  it("tells money leaving at once while a move of theirs only waits on what it kept", async () => {
    // Stopped after its swap landed: all it may have sent is kept, so a theft isn't held up.
    await insertAction({
      tool: "polymarket_order",
      phase: "unsure",
      startedAt: minutesAgo(5),
      error: "Polymarket rejected the order",
      txs: [{ chain: "polygon", hash: "0xswap", setup: true }],
    });
    const usdc = NETWORKS.polygon.usdc;
    await hint("polygon", "0xdrain", [
      transfer({ position: usdc, instrument: usdc, baseUnits: -9_000_000n }),
    ]);
    expect(await recorded()).toEqual([expect.objectContaining({ kind: "external_out" })]);
  });

  it("waits on a transaction the wallet signed while a move of theirs hasn't kept its hash", async () => {
    // A Solana swap sent, its signature not back from the wallet yet: no placeholder names it.
    await insertAction({ tool: "solana_swap", startedAt: minutesAgo(1), txs: [] });
    const usdc = NETWORKS.solana.usdc;
    await expect(
      hint(
        "solana",
        "sig",
        [transfer({ position: usdc, instrument: usdc, baseUnits: -5_000_000n })],
        minutesAgo(1),
        true,
      ),
    ).rejects.toThrow(NotKnownYet);
    expect(await recorded()).toEqual([]);
  });

  it("counts money the wallet sent itself, outside Auni, as taken out", async () => {
    // ETH sent to an exchange with the exported key, no move of Auni's running.
    await hint(
      "base",
      "0xexported",
      [
        transfer({
          position: "call:1",
          instrument: "native",
          decimals: 18,
          baseUnits: -(10n ** 16n),
        }),
      ],
      minutesAgo(1),
      true,
    );
    expect((await recorded()).map((row) => row.kind)).toEqual(["external_out"]);
  });

  it("knows an order's kept send is named once the venue names its trades", async () => {
    // A Polymarket order kept before its trades' hashes came back, and those hashes after.
    await insertAction({
      tool: "polymarket_order",
      startedAt: minutesAgo(1),
      txs: [{ chain: "polygon" }, { chain: "polygon", hash: "0xtrade" }],
    });
    vi.mocked(readTransfers).mockResolvedValue({
      at: minutesAgo(1),
      block: 1,
      transfers: [transfer({ instrument: NETWORKS.polygon.usdc.toLowerCase() })],
      walletSigned: false,
      closedAccounts: [],
    });
    await recordArrivals("polygon", "0xdeposit");
    expect(await recorded()).toEqual([expect.objectContaining({ kind: "deposit" })]);
  });

  it("counts a deposit or money sent out of anything but cash as money put in or taken out", async () => {
    await hint("base", "0xusdc", [transfer({})], minutesAgo(30));
    await hint(
      "base",
      "0xeth",
      [transfer({ instrument: "native", decimals: 18, baseUnits: 81n * 10n ** 15n })],
      minutesAgo(20),
    );
    await hint(
      "base",
      "0xout",
      [transfer({ instrument: "native", decimals: 18, baseUnits: -(10n ** 16n) })],
      minutesAgo(10),
    );

    // 1.097 STRCx is one share, which DefiLlama prices, not one 1.097 times as dear.
    await hint(
      "base",
      "0xstock",
      [
        transfer({
          instrument: XSTOCK,
          decimals: 18,
          baseUnits: 1_097n * 10n ** 15n,
          pricedUnits: 10n ** 18n,
        }),
      ],
      minutesAgo(5),
    );

    const flows = await walletFlows();
    expect(flows.map((flow) => flow.usd)).toEqual([210.6, -26, 100]);
    // $5 of cash, 0.071 ETH at the $2,600 it came in at, and the share at $100: nothing made.
    expect(madeUsd(5 + 184.6 + 100, 5, flows)).toBe("0.00");
  });
});

describe("a Solana token account closed between sweeps", () => {
  const ACCOUNT = "BonkAccount1111111111111111111111111111111";
  /** What the chain shows: each transaction's slot, what it moved, and the addresses it names. */
  interface OnChain {
    readonly slot: number;
    readonly transfers: Transfer[];
    readonly names: readonly string[];
    readonly walletSigned?: boolean;
    readonly closedAccounts?: { address: string; mint: string }[];
    readonly unreadable?: boolean;
  }
  let onChain: Map<string, OnChain>;
  let accountsNow: { pubkey: string; mint: string }[];
  let head: number;
  let listed: string[];
  /** Whole BONK at $0.00002, signed as it moved. */
  const bonk = (whole: bigint) =>
    transfer({
      position: BONK,
      instrument: BONK,
      decimals: 5,
      baseUnits: whole * 100_000n,
      counterparty: null,
    });

  beforeEach(() => {
    onChain = new Map();
    listed = [];
    vi.mocked(solanaRpc).mockImplementation((async (method: string, params: unknown[]) => {
      if (method === "getSlot") return head;
      if (method === "getTokenAccountsByOwner") {
        const [, { programId }] = params as [string, { programId: string }];
        if (programId !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") return { value: [] };
        return {
          value: accountsNow.map(({ pubkey, mint }) => ({
            pubkey,
            account: { data: { parsed: { info: { mint, tokenAmount: { amount: "1" } } } } },
          })),
        };
      }
      if (method === "getSignaturesForAddress") {
        const [address, { before, limit }] = params as [string, { before?: string; limit: number }];
        listed.push(address);
        const naming = [...onChain]
          .filter(([, tx]) => tx.names.includes(address) && tx.slot <= head)
          .toSorted(([, a], [, b]) => b.slot - a.slot);
        const start = before ? naming.findIndex(([hash]) => hash === before) + 1 : 0;
        return naming
          .slice(start, start + limit)
          .map(([signature, { slot }]) => ({ signature, slot, err: null }));
      }
      throw new Error(`unexpected ${method}`);
    }) as never);
    vi.mocked(readTransfers).mockClear();
    vi.mocked(readTransfers).mockImplementation(async (_chain, hash) => {
      const tx = onChain.get(hash);
      if (!tx || tx.unreadable) throw new Error(`${hash} can't be read`);
      return {
        at: minutesAgo((10_000 - tx.slot) / 100),
        transfers: tx.transfers,
        block: tx.slot,
        walletSigned: tx.walletSigned ?? false,
        closedAccounts: tx.closedAccounts ?? [],
      };
    });
    // The wallet holds what the chain moved by its head.
    vi.mocked(solanaTokens).mockImplementation(async () => {
      const moved = [...onChain.values()]
        .filter(({ slot }) => slot <= head)
        .flatMap(({ transfers }) => transfers)
        .filter(({ instrument }) => instrument === BONK)
        .reduce((sum, { baseUnits }) => sum + baseUnits, 0n);
      const amount = moved > 0n ? moved : 0n;
      return { slot: head, byMint: new Map([[BONK, { amount, decimals: 5, slot: head }]]) };
    });
    // DefiLlama prices BONK and no spam.
    vi.mocked(tokenPrices).mockImplementation(async (ids) => ({
      prices: new Map(
        ids.flatMap((id) => (id === `solana:${BONK}` ? [[id, { price: 0.00002 }] as const] : [])),
      ),
      complete: true,
    }));
  });

  afterEach(() => {
    vi.mocked(solanaRpc).mockReset();
    vi.mocked(tokenPrices).mockReset();
  });

  /** The $20 that came in, then left with the account as the wallet emptied and closed it. */
  function toppedUpAndClosed(topupReadable = true) {
    onChain.set("topup", {
      slot: 6_000,
      transfers: [bonk(1_000_000n)],
      names: [ACCOUNT],
      unreadable: !topupReadable,
    });
    onChain.set("close", {
      slot: 6_100,
      transfers: [bonk(-1_500_000n)],
      names: [SOLANA_WALLET, ACCOUNT],
      walletSigned: true,
      closedAccounts: [{ address: ACCOUNT, mint: BONK }],
    });
  }

  it("still records what a priced account received before it closed, though nothing lists the account now", async () => {
    // $10 of BONK into a fresh account, whose creation names the wallet.
    onChain.set("create", {
      slot: 100,
      transfers: [bonk(500_000n)],
      names: [SOLANA_WALLET, ACCOUNT],
    });
    accountsNow = [{ pubkey: ACCOUNT, mint: BONK }];
    head = 5_000;
    await sweepNetwork("solana", SOLANA_WALLET);
    // Then $20 more into the account alone, before the wallet sends all $30 out and closes it.
    toppedUpAndClosed();
    accountsNow = [];
    head = 9_000;
    await sweepNetwork("solana", SOLANA_WALLET);
    expect(
      (await recorded()).map(({ txHash, kind, usdValue }) => [txHash, kind, usdValue]),
    ).toEqual([
      ["create", "deposit", "10.00"],
      ["topup", "deposit", "20.00"],
      ["close", "external_out", "-30.00"],
    ]);
    // Put in $30, took out $30: nothing made.
    expect(madeUsd(0, 0, await walletFlows())).toBe("0.00");
  });

  it("records no closing while what the account received can't be read, so it is read again", async () => {
    toppedUpAndClosed(false);
    await expect(recordArrivals("solana", "close")).rejects.toThrow("topup can't be read");
    expect(await recorded()).toEqual([]);
  });

  it("reads a closed account back only a sweep's few pages, however much was sent into it", async () => {
    // Five thousand transactions into the account, then the wallet closes it.
    for (let index = 0; index < 5_000; index += 1)
      onChain.set(`flood${index}`, { slot: 1_000 + index, transfers: [], names: [ACCOUNT] });
    toppedUpAndClosed();
    head = 9_000;
    await recordArrivals("solana", "close");
    expect(listed).toEqual([ACCOUNT, ACCOUNT, ACCOUNT]);
    expect((await recorded()).map(({ txHash }) => txHash)).toEqual(["topup", "close"]);
  });

  it("lists no account of spam the wallet closed, nor reads what it received", async () => {
    const spam = Array.from({ length: 40 }, (_, index) => ({
      address: `SpamAccount${index}`,
      mint: `SpamMint${index}`,
    }));
    for (const { address } of spam)
      onChain.set(`junk-${address}`, { slot: 5_900, transfers: [], names: [address] });
    onChain.set("tidy", {
      slot: 6_000,
      transfers: [],
      names: [SOLANA_WALLET, ...spam.map(({ address }) => address)],
      walletSigned: true,
      closedAccounts: spam,
    });
    accountsNow = [];
    head = 9_000;
    await sweepNetwork("solana", SOLANA_WALLET);
    expect(listed).toEqual([SOLANA_WALLET]);
    expect(vi.mocked(readTransfers).mock.calls.map(([, hash]) => hash)).toEqual(["tidy"]);
  });
});

describe("when an arrival counts", () => {
  /** `units` LINK, at $15 each, moved in or out. */
  const link = (units: bigint, position = "log:0") =>
    transfer({ position, instrument: LINK, decimals: 18, baseUnits: units * 10n ** 18n });

  /** What readings `days` ago made, each holding just $5 of cash. */
  async function madeAt(days: readonly number[]) {
    const flows = await walletFlows();
    return days.map((ago) => madeUsd(5, 5, flows, daysAgo(ago).getTime()));
  }

  it("counts a token no reading held from when it was recorded, as when a first sweep finds it", async () => {
    // 5 LINK, $75, sent in ten days ago, which nothing told Auni of until now.
    await hint("base", "0xlink", [link(5n)], daysAgo(10));
    // Readings since held none of the LINK, which Auni didn't yet know to read.
    expect(await madeAt([5])).toEqual(["0.00"]);
    expect(madeUsd(5 + 75, 5, await walletFlows())).toBe("0.00");
  });

  it("counts from when it moved what readings held then, and from the first that held it after", async () => {
    const action = await insertAction({ status: "done" });
    const [first, moved, later] = [daysAgo(20), daysAgo(10), daysAgo(5)];
    const bought = (instrument: string, createdAt: Date) =>
      db.insert(fills).values({
        actionId: action.id,
        chain: "base",
        instrument: getAddress(instrument),
        side: "buy",
        quantity: "1",
        usdValue: "1",
        createdAt,
      });
    // A chain's own coin is always read; a Solana token, as any other, once Auni counts it.
    await hint(
      "base",
      "0xeth",
      [transfer({ instrument: "native", decimals: 18, baseUnits: 10n ** 15n })],
      moved,
    );
    await hint(
      "solana",
      "bonk",
      [transfer({ position: BONK, instrument: BONK, decimals: 5, baseUnits: 10n ** 11n })],
      moved,
    );
    // LINK was bought before it came in, so read since; the xStock only after.
    await bought(LINK, first);
    await bought(XSTOCK, later);
    await hint("base", "0xlink", [link(1n)], moved);
    await hint(
      "base",
      "0xstock",
      [transfer({ position: "log:1", instrument: XSTOCK, decimals: 18, baseUnits: 10n ** 18n })],
      moved,
    );

    // The $1 buys, then what came in: the BONK as what the wallet held when it began to count.
    const [bonk] = await db
      .select({ keptAt: otherTokens.keptAt })
      .from(otherTokens)
      .where(eq(otherTokens.instrument, BONK));
    const flows = await walletFlows();
    // The coin, never looked at before it came in, is put in as the look found it, from the
    // start, as every reading of the wallet holds it.
    expect(flows.map((flow) => [flow.at, flow.usd]).toSorted(([, a], [, b]) => a! - b!)).toEqual([
      [first.getTime(), 1],
      [later.getTime(), 1],
      [0, 2.6],
      [moved.getTime(), 15],
      [bonk!.keptAt!.getTime(), 20],
      [later.getTime(), 100],
    ]);
    expect(bonk!.keptAt!.getTime()).toBeGreaterThan(later.getTime());
  });

  it("counts a token that came in before from its first arrival with a price", async () => {
    const [found, moved] = [daysAgo(20), daysAgo(10)];
    await db.insert(arrivals).values({
      chain: "base",
      txHash: "0xfirst",
      position: "log:0",
      instrument: LINK,
      baseUnits: String(10n ** 18n),
      decimals: 18,
      usdValue: "15.00",
      kind: "deposit",
      at: daysAgo(30),
      block: 1,
      countsFrom: found,
      createdAt: found,
    });
    await hint("base", "0xlink", [link(1n)], moved);
    expect((await walletFlows()).map((flow) => flow.at)).toEqual([
      found.getTime(),
      moved.getTime(),
    ]);
  });

  it("counts money sent out from when it left when readings held it, else with what brought it in", async () => {
    const left = daysAgo(3);
    await hint(
      "base",
      "0xout",
      [transfer({ instrument: "native", decimals: 18, baseUnits: -(10n ** 16n) })],
      left,
    );
    expect((await walletFlows()).map((flow) => [flow.at, flow.usd])).toEqual([
      [left.getTime(), -26],
    ]);

    // A first sweep finds LINK that came in ten days ago and left five days ago: no
    // reading held any of it, so none made or lost anything by it.
    await wipe();
    await hint("base", "0xin", [link(5n)], daysAgo(10));
    await hint("base", "0xlinkout", [link(-5n)], daysAgo(5));
    expect(await madeAt([7, 4])).toEqual(["0.00", "0.00"]);
    expect(madeUsd(5, 5, await walletFlows())).toBe("0.00");
  });
});

describe("deposits a waiting screen sees land", () => {
  it("lists their latest deposits told, a cent or more, recorded in the last hour, named as recorded", async () => {
    const row = (txHash: string, fields: Partial<typeof arrivals.$inferInsert> = {}) => ({
      chain: "base",
      txHash,
      position: "log:0",
      instrument: LINK,
      baseUnits: String(81n * 10n ** 15n),
      decimals: 18,
      usdValue: "1.22",
      symbol: "LINK",
      kind: "deposit" as const,
      at: daysAgo(3),
      block: 1,
      createdAt: minutesAgo(1),
      ...fields,
    });
    await db
      .insert(arrivals)
      .values([
        row("0xeth", { instrument: "native", usdValue: "210.60", createdAt: minutesAgo(2) }),
        row("0xlink"),
        row("0xstale", { createdAt: minutesAgo(90) }),
        row("0xdust", { usdValue: "0.00" }),
        row("0xcent", { usdValue: "0.01", createdAt: minutesAgo(1.5) }),
        row("0xspam", { instrument: SPAM, usdValue: null }),
        row("0xpayout", { kind: "payout" }),
        row("0xlanding", { kind: "landing" }),
        row("0xout", { kind: "external_out", baseUnits: "-1", usdValue: "-1.22" }),
      ]);

    const recent = await recentDeposits();
    expect(recent.map((deposit) => deposit.txHash)).toEqual(["0xlink", "0xcent", "0xeth"]);
    const [link, , eth] = recent;
    expect(depositWire(link!)).toEqual({
      id: link!.id,
      symbol: "LINK",
      amount: "0.081",
      network: "Base",
      usdValue: "1.22",
    });
    expect(depositWire(eth!)).toMatchObject({ symbol: "ETH", usdValue: "210.60" });
    // One recorded with no name is named by its address.
    expect(depositWire({ ...link!, symbol: null }).symbol).toBe(shortAddress(LINK));
  });
});

describe("readPortfolio", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads a token recorded arriving or counted since, never one only seen, so anyone's spam costs no read", async () => {
    await db.insert(arrivals).values({
      chain: "base",
      txHash: "0x0",
      position: "log:0",
      instrument: LINK,
      baseUnits: "1000",
      decimals: 18,
      usdValue: "75.00",
      kind: "deposit" as const,
      at: minutesAgo(30),
      block: 1,
    });
    await seeTokens(db, "base", [SPAM]);
    const asked: string[] = [];
    vi.spyOn(publicClient("base"), "multicall").mockImplementation((async ({
      contracts,
    }: {
      contracts: { address: string }[];
    }) => {
      asked.push(...contracts.map(({ address }) => address.toLowerCase()));
      return contracts.map(() => ({ status: "failure", error: new Error("unread") }));
    }) as never);
    // Every venue is out of reach; only what the base wallet is asked for matters here.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await readPortfolio().catch(() => null);
    expect(asked).toContain(LINK);
    expect(asked).not.toContain(SPAM);
  });

  it("reads a Solana wallet's SOL, cash and tokens counted, whatever its spam or the lists' state", async () => {
    await db.insert(arrivals).values({
      chain: "solana",
      txHash: "sig",
      position: "token:0",
      instrument: BONK,
      baseUnits: "1000",
      decimals: 5,
      usdValue: "0.02",
      kind: "deposit" as const,
      at: minutesAgo(30),
      block: 1,
    });
    const spam = "Spam111111111111111111111111111111111111111";
    vi.mocked(solanaRpc).mockImplementation((async (method: string, params: unknown[]) => {
      if (method === "getBalance") return { value: 10 ** 9 };
      const [, { programId }] = params as [string, { programId: string }];
      if (programId !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
        return { context: { slot: 1 }, value: [] };
      return {
        context: { slot: 1 },
        value: [NETWORKS.solana.usdc, BONK, spam].map((mint) => ({
          account: {
            data: { parsed: { info: { mint, tokenAmount: { amount: "1000", decimals: 5 } } } },
          },
        })),
      };
    }) as never);
    // Jupiter is out of reach, and has never been asked of the spam mint.
    vi.mocked(listings).mockImplementation(async (chain, instruments, unreadable) => {
      if (unreadable !== "unlisted" && instruments.some((mint) => !mint.startsWith("EPj")))
        throw new Error("Jupiter unavailable");
      return listingsOf({})(chain, instruments);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    const portfolio = await readPortfolio();
    expect(portfolio.unavailable).not.toContain("solana");
    const solana = portfolio.holdings.filter(({ chain }) => chain === "solana");
    expect(solana.map(({ instrument }) => instrument).toSorted()).toEqual(
      ["native", NETWORKS.solana.usdc, BONK].toSorted(),
    );
    expect(vi.mocked(listings).mock.calls.flatMap(([, instruments]) => instruments)).not.toContain(
      spam,
    );
    vi.mocked(solanaRpc).mockReset();
  });
});

describe("the coin a card bought for a chain's fees, as it arrives", () => {
  // A bridge out of Arbitrum whose card bought the ETH for its fee with 15 MON through Relay
  // (fee-coin.ts). The MON leaves in the move's own send; the ETH arrives in one Relay sends.
  const CARD = {
    feeCoinOn: "arbitrum",
    feeCoinFrom: "monad",
    feeCoinToken: "native",
    feeCoinAmount: (15n * 10n ** 18n).toString(),
    feeCoinUsd: "0.25",
    feeCoinBy: "Relay",
  };
  const ORDER = `0x${"ab".repeat(32)}`;
  const bought = { chain: "monad", hash: "0xpurchase", setup: true as const, buysFees: ORDER };
  const coin = (baseUnits: bigint) =>
    transfer({ position: "call:0", instrument: "native", decimals: 18, baseUnits });
  const eth = coin(10n ** 14n);
  const bridge = (fields: Partial<typeof actions.$inferInsert> = {}) =>
    insertAction({
      tool: "bridge_usdc",
      input: { from_chain: "arbitrum", to_chain: "monad", amount: "2" },
      details: CARD,
      startedAt: minutesAgo(2),
      txs: [bought],
      ...fields,
    });
  /** Where Relay says the order stands, and what it says paid it. */
  const relay = (status: PayInStanding["status"], paidIn: string[] = []) =>
    vi.mocked(payInStanding).mockImplementation(async (order) => {
      expect(order).toBe(ORDER);
      return { status, paidIn };
    });
  const made = async () => (await walletFlows()).filter((flow) => flow.key === "arbitrum:native");

  it("is the move's own, never money put in: nothing told, and what was made unchanged", async () => {
    const waiting = await insertThread({ awaitingDepositSince: minutesAgo(5) });
    // The run kept what Relay paid the wallet with as Relay named it.
    const paid = { chain: "arbitrum", hash: "0xrelaypays", setup: true as const, buysFees: ORDER };
    const move = await bridge({ threadId: waiting.id, txs: [bought, paid] });
    await hint("monad", "0xpurchase", [coin(-(15n * 10n ** 18n))], minutesAgo(1), true);
    await hint("arbitrum", "0xrelaypays", [eth]);
    expect(await recorded()).toEqual([
      { kind: "own_move", usdValue: null, actionId: move.id, txHash: "0xpurchase" },
      { kind: "own_move", usdValue: "0.26", actionId: move.id, txHash: "0xrelaypays" },
    ]);
    expect(await wakes()).toEqual([]);
    expect(await made()).toEqual([]);
    expect(vi.mocked(payInStanding)).not.toHaveBeenCalled();
  });

  it("is known by Relay's own word for what paid the order, when it is read before the run kept it", async () => {
    // The sweep sees the ETH land while the run still waits on Relay's answer.
    const move = await bridge();
    relay("success", ["0xRelayPays"]);
    await hint("arbitrum", "0xrelaypays", [eth]);
    expect(await recorded()).toEqual([
      { kind: "own_move", usdValue: "0.26", actionId: move.id, txHash: "0xrelaypays" },
    ]);
    expect(await wakes()).toEqual([]);
    // Kept on the move from then on, so nothing asks Relay of it again.
    const [kept] = await db.select().from(actions).where(eq(actions.id, move.id));
    expect(kept!.txs).toEqual([
      bought,
      { chain: "arbitrum", hash: "0xrelaypays", setup: true, buysFees: ORDER },
    ]);
  });

  it("is known the same way for a payout that comes after its move failed for want of it", async () => {
    const move = await bridge({ status: "failed", phase: null, failureKind: "fees" });
    relay("success", ["0xrelaypays"]);
    await hint("arbitrum", "0xrelaypays", [eth]);
    expect(await recorded()).toMatchObject([{ kind: "own_move", actionId: move.id }]);
    expect(await made()).toEqual([]);
  });

  it("waits while Relay hasn't said what pays the order, and Relay can't be asked", async () => {
    await bridge();
    relay("pending");
    await expect(hint("arbitrum", "0xmaybe", [eth])).rejects.toThrow(NotKnownYet);
    vi.mocked(payInStanding).mockRejectedValue(new Error("offline"));
    await expect(hint("arbitrum", "0xmaybe", [eth])).rejects.toThrow(NotKnownYet);
    expect(await recorded()).toEqual([]);
  });

  it("knows SOL a card bought the same way, by the signature Relay names, its case kept", async () => {
    // A move on Solana whose card bought SOL with a dollar of Monad's USDC (sol-top-up.ts).
    const move = await insertAction({
      tool: "solana_swap",
      input: { token: "JUP", side: "buy", amountUsd: 2 },
      details: {
        ...CARD,
        feeCoinOn: "solana",
        feeCoinToken: NETWORKS.monad.usdc,
        feeCoinUsd: "1.00",
      },
      startedAt: minutesAgo(2),
      txs: [bought],
    });
    const sol = transfer({
      position: "sol:0",
      instrument: "native",
      decimals: 9,
      baseUnits: 10n ** 7n,
    });
    relay("success", ["5SigOfRelayPayingSol"]);
    await hint("solana", "5SigOfRelayPayingSol", [sol]);
    expect(await recorded()).toMatchObject([
      { kind: "own_move", actionId: move.id, txHash: "5SigOfRelayPayingSol" },
    ]);
    const [kept] = await db.select().from(actions).where(eq(actions.id, move.id));
    expect(kept!.txs.at(-1)).toEqual({
      chain: "solana",
      hash: "5SigOfRelayPayingSol",
      setup: true,
      buysFees: ORDER,
    });
    expect(await wakes()).toEqual([]);
  });

  it("tells any other coin arriving as the deposit it is", async () => {
    await bridge();
    // Relay names another transaction as what paid the order: this one is someone else's.
    relay("success", ["0xrelaypays"]);
    await hint("arbitrum", "0xfromafriend", [eth]);
    // Coin on another chain, and a token on this one, never ask Relay at all.
    vi.mocked(payInStanding).mockClear();
    await hint("base", "0xonbase", [eth]);
    await hint("arbitrum", "0xusdc", [
      transfer({ instrument: NETWORKS.arbitrum.usdc.toLowerCase() }),
    ]);
    expect(vi.mocked(payInStanding)).not.toHaveBeenCalled();
    expect((await recorded()).map(({ kind, actionId }) => [kind, actionId])).toEqual([
      ["deposit", null],
      ["deposit", null],
      ["deposit", null],
    ]);
    // A move that bought long ago holds nothing up, whatever Relay says of it by now.
    await wipe(actions, arrivals);
    await bridge({ status: "failed", phase: null, startedAt: minutesAgo(45) });
    relay("pending");
    await hint("arbitrum", "0xlater", [eth]);
    expect(await recorded()).toMatchObject([{ kind: "deposit", actionId: null }]);
  });
});
