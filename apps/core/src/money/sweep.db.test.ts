import { EVM_CASH_KEYS, EVM_CHAIN_KEYS, NETWORKS, type EvmChainKey } from "@auni/shared";
import {
  CallExecutionError,
  InvalidParamsRpcError,
  pad,
  RpcRequestError,
  TimeoutError,
  toHex,
  type Hex,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appTroublesNow } from "../app-troubles.ts";
import { db } from "../db/client.ts";
import { env } from "../env.ts";
import { actions, appTroubles, arrivalCursors, fills, otherTokens } from "../db/schema.ts";
import { insertAction, wipe } from "../test/db.ts";
import { WALLET } from "../test/chain.ts";
import { listingsOf } from "../test/recognised.ts";

import { NotKnownYet, recordArrivals } from "./arrivals.ts";
import { eachRpc, publicClient, solanaRpc } from "./chains.ts";
import { logSpan, transferLogs } from "./evm-history.ts";
import { tokenPrices } from "./history.ts";
import { countWhatWasThere } from "./other-tokens.ts";
import { listings } from "./recognised.ts";
import { sweepArrivals, sweepNetwork } from "./sweep.ts";
import { TRANSFER_TOPIC } from "./transfers.ts";
import { payoutSweeps } from "./payouts.ts";
import { statementSweeps } from "./statements.ts";

vi.mock("./arrivals.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordArrivals: vi.fn(),
}));
vi.mock("./chains.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  solanaRpc: vi.fn(),
}));
vi.mock("./wallets.ts", async (o) => (await import("../test/chain.ts")).wallets(await o()));
vi.mock("./payouts.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  payoutSweeps: vi.fn(() => []),
}));
vi.mock("./statements.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  statementSweeps: vi.fn(() => []),
}));
vi.mock("./history.ts", async (o) => (await import("../test/chain.ts")).history(await o(), {}));
vi.mock("./recognised.ts", async (o) => (await import("../test/chain.ts")).recognised(await o()));
// What a wallet held before its first sweep is other-tokens.db.test.ts's to test.
vi.mock("./other-tokens.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  countWhatWasThere: vi.fn(async () => {}),
}));

const LINK = "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCaLpQr7wKWbELgGhVm";

const STRANGER = "0x2222222222222222222222222222222222222222";

/** A token moving in or out, as its Transfer log says: the chain's USDC in, unless it says otherwise. */
interface TokenMove {
  readonly hash: string;
  readonly block: number;
  readonly token?: string;
  readonly out?: true;
  readonly units?: bigint;
}

/** The chain's coin arriving: in a transaction to the wallet, or, without a hash, sent by a contract. */
interface CoinMove {
  readonly block: number;
  readonly units: bigint;
  readonly hash?: string;
}

/** How one of a chain's RPCs serves logs: up to `refuseOver` blocks a call, or no answer at all. */
interface LogRpc {
  refuseOver: number;
  /** It gives no answer in time, as Polygon's second public RPC often doesn't (November 2026). */
  silent: boolean;
  /** How it refuses a span too wide: each RPC says it its own way. */
  refusal: () => Error;
  /**
   * How many blocks behind the chain's head it is. Asked for blocks it hasn't reached it answers
   * an empty list, as arb1.arbitrum.io, polygon.drpc.org, Robinhood's RPC and rpc.monad.xyz do
   * (probed 2026-11-14).
   */
  behind: number;
}

/**
 * One chain as its RPCs answer: Transfer logs, past balances and blocks. Each of the chain's
 * RPCs serves logs as its entry in `rpcs` says, the first up to `refuseOver` blocks a call and
 * every other any span. Each eth_getLogs call takes `msPerCall` of `clock`, which Date.now reads
 * where a test sets it, and after `answersFor` calls no RPC answers.
 */
function fakeChain(chain: EvmChainKey, refuseOver = Infinity) {
  const client = publicClient(chain);
  const usdc = NETWORKS[chain].usdc ?? "0x0000000000000000000000000000000000000000";
  const endpoints = eachRpc(chain);
  const state = {
    head: 5_000,
    tokens: [] as TokenMove[],
    coin: [] as CoinMove[],
    asked: [] as { from: number; to: number; side: "in" | "out"; rpc: string }[],
    /** The RPCs asked how far they have got, in order. */
    headAsked: [] as string[],
    balanceReads: 0,
    rpcs: endpoints.map((_, index): LogRpc => ({
      refuseOver: index === 0 ? refuseOver : Infinity,
      silent: false,
      refusal: () => new InvalidParamsRpcError(new Error("block range too large")),
      behind: 0,
    })),
    answersFor: Infinity,
    clock: 0,
    msPerCall: 0,
  };
  vi.spyOn(client, "getBlockNumber").mockImplementation(async () => BigInt(state.head));
  endpoints.forEach(({ url, client: endpoint }, index) =>
    vi.spyOn(endpoint, "request").mockImplementation((async ({
      method,
      params,
    }: {
      method: string;
      params: [{ fromBlock: Hex; toBlock: Hex; topics: (Hex | null)[] }];
    }) => {
      const rpc = state.rpcs[index]!;
      const reached = state.head - rpc.behind;
      if (method === "eth_blockNumber") {
        state.headAsked.push(url);
        if (rpc.silent) throw new TimeoutError({ body: {}, url });
        return toHex(reached);
      }
      if (method !== "eth_getLogs") throw new Error(`unexpected ${method}`);
      const [{ fromBlock, toBlock, topics }] = params;
      const [from, to] = [Number(fromBlock), Number(toBlock)];
      const side = topics.length === 3 ? "in" : "out";
      state.asked.push({ from, to, side, rpc: url });
      state.clock += state.msPerCall;
      // No answer at all, as when the RPC is unreachable.
      if (state.asked.length > state.answersFor) throw new Error("fetch failed");
      if (rpc.silent) throw new TimeoutError({ body: {}, url });
      if (to - from + 1 > rpc.refuseOver) throw rpc.refusal();
      return state.tokens
        .filter(
          (move) =>
            move.block >= from &&
            move.block <= Math.min(to, reached) &&
            (move.out ? "out" : "in") === side,
        )
        .map(({ hash, block, token = usdc, out, units = 1n }) => ({
          address: token,
          topics: [TRANSFER_TOPIC, pad(out ? WALLET : STRANGER), pad(out ? STRANGER : WALLET)],
          data: pad(toHex(units)),
          blockNumber: toHex(block),
          transactionHash: hash,
        }));
    }) as never),
  );
  vi.spyOn(client, "getBalance").mockImplementation(async ({ blockNumber }) => {
    state.balanceReads += 1;
    return state.coin
      .filter(({ block }) => block <= Number(blockNumber))
      .reduce((sum, { units }) => sum + units, 1_000n);
  });
  vi.spyOn(client, "getBlock").mockImplementation((async ({
    blockNumber,
  }: {
    blockNumber: bigint;
  }) => ({
    number: blockNumber,
    transactions: state.coin.flatMap(({ block, units, hash }) =>
      hash && block === Number(blockNumber) ? [{ hash, to: WALLET, value: units }] : [],
    ),
  })) as never);
  return state;
}

let chain: ReturnType<typeof fakeChain>;

beforeEach(async () => {
  await wipe(arrivalCursors, actions, fills, otherTokens, appTroubles);
  // The lists recognise the network's coins and cash, LINK and BONK; never spam.
  vi.mocked(listings).mockReset();
  vi.mocked(listings).mockImplementation(
    listingsOf({ [`base:${LINK}`]: "LINK", [`solana:${BONK}`.toLowerCase()]: "Bonk" }),
  );
  vi.mocked(recordArrivals).mockReset();
  vi.mocked(tokenPrices).mockReset();
  vi.restoreAllMocks();
  chain = fakeChain("base");
});

const cursor = async (chain?: string) =>
  (await db.select().from(arrivalCursors)).find((row) => !chain || row.chain === chain)?.block;
const sweptFrom = (block: number) => db.insert(arrivalCursors).values({ chain: "base", block });
const hinted = () => vi.mocked(recordArrivals).mock.calls.map(([, hash]) => hash);

describe("sweepArrivals", () => {
  it("keeps an app's read that fails on the app until it reads again, and sweeps the rest", async () => {
    const market = { id: "market", name: "Market" };
    // As Polymarket answered every sweep once it retired its data API v1 (November 2026).
    const retired = new Error(
      'Polymarket data API answered HTTP 410: {"error":"Data API v1 has been retired"}',
    );
    const payouts = vi.fn(async (): Promise<void> => {
      throw retired;
    });
    const statement = vi.fn(async () => {});
    vi.mocked(payoutSweeps).mockReturnValue([
      { app: market, work: "reading payouts", run: payouts },
    ]);
    vi.mocked(statementSweeps).mockReturnValue([
      { app: { id: "perps", name: "Perps" }, work: "reading its statement", run: statement },
    ]);
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const other of EVM_CHAIN_KEYS) if (other !== "base") fakeChain(other);
    await sweepArrivals();
    expect(payoutSweeps).toHaveBeenCalledWith(WALLET);
    expect(await vi.mocked(statementSweeps).mock.calls[0]![0]()).toBe(WALLET);
    expect(statement).toHaveBeenCalled();
    // Each network is swept all the same, every one once, for what the wallet held there before.
    const swept = async () =>
      (await db.select().from(arrivalCursors)).map(({ chain }) => chain).toSorted();
    expect(await swept()).toEqual([...EVM_CHAIN_KEYS].toSorted());
    expect(
      vi
        .mocked(countWhatWasThere)
        .mock.calls.map(([one]) => one)
        .toSorted(),
    ).toEqual([...EVM_CHAIN_KEYS].toSorted());
    await sweepArrivals();
    // Where the owner looks, and in the log once rather than every sweep.
    expect(await appTroublesNow()).toMatchObject([
      {
        app: "market",
        work: "reading payouts",
        kind: "failing",
        said: retired.message,
        times: 2,
      },
    ]);
    expect(said.mock.calls.filter(([words]) => String(words).startsWith("Market"))).toEqual([
      ["Market: reading payouts failed:", retired],
    ]);
    payouts.mockResolvedValue(undefined);
    await sweepArrivals();
    expect(await appTroublesNow()).toEqual([]);
  });

  // A wallet brought in with money already on a network Auni doesn't spend cash on, such as ETH
  // on Ethereum, would otherwise never be read there, so never shown.
  it("sweeps every network once, then only where cash is spent or money has been", async () => {
    vi.mocked(payoutSweeps).mockReturnValue([]);
    vi.mocked(statementSweeps).mockReturnValue([]);
    const chains = new Map(
      EVM_CHAIN_KEYS.map((one) => [one, one === "base" ? chain : fakeChain(one)]),
    );
    await sweepArrivals();
    for (const state of chains.values()) state.asked = [];
    vi.mocked(countWhatWasThere).mockClear();
    await sweepArrivals();
    const asked = [...chains].flatMap(([one, state]) => (state.asked.length > 0 ? [one] : []));
    expect(asked.toSorted()).toEqual(EVM_CASH_KEYS.toSorted());
    expect(countWhatWasThere).not.toHaveBeenCalled();
  });
});

describe("sweepNetwork", () => {
  it("starts a network never swept at its latest blocks, then sweeps on from the last block read", async () => {
    chain.tokens = [
      { hash: "0xOLD", block: 3_000 },
      { hash: "0xIN", block: 4_010 },
      { hash: "0xout", block: 4_020, out: true },
      { hash: "0xin", block: 4_010, out: true },
    ];
    await sweepNetwork("base", WALLET);
    // Money in and out of the latest OVERLAP blocks; what came before is the balance readings start from.
    expect(chain.asked).toMatchObject([
      { from: 4_000, to: 5_000, side: "in" },
      { from: 4_000, to: 5_000, side: "out" },
    ]);
    expect(vi.mocked(recordArrivals).mock.calls).toEqual([
      ["base", "0xin"],
      ["base", "0xout"],
    ]);
    // Read through the head, but its last OVERLAP blocks are read again next time.
    expect(await cursor()).toBe(4_000);

    chain.asked = [];
    chain.head = 6_000;
    await sweepNetwork("base", WALLET);
    expect(chain.asked[0]).toMatchObject({ from: 4_001, to: 6_000, side: "in" });
    expect(await cursor()).toBe(5_000);
  });

  it("goes on past transactions that record nothing, however many sit together", async () => {
    await sweptFrom(3_999);
    chain.head = 9_000;
    // 60 transactions in a row that move nothing the wallet holds, so none leaves an arrival.
    chain.tokens = [
      ...Array.from({ length: 60 }, (_, index) => ({
        hash: `0x${(index + 1).toString(16)}`,
        block: 4_000 + index,
      })),
      { hash: "0xdeposit", block: 7_000 },
    ];
    await sweepNetwork("base", WALLET);
    await sweepNetwork("base", WALLET);
    expect(hinted()).toContain("0xdeposit");
    expect(await cursor()).toBe(8_000);
  });

  it("works through a long history oldest first, a sweep at a time", async () => {
    await sweptFrom(0);
    chain.head = 9_000;
    chain.tokens = Array.from({ length: 60 }, (_, index) => ({
      hash: `0x${(60 - index).toString(16)}`,
      block: 100 * (60 - index),
    }));
    await sweepNetwork("base", WALLET);
    expect(hinted()).toHaveLength(50);
    expect(hinted()[0]).toBe("0x1");
    // How far it got, not the head: the next sweep picks up from the 51st.
    expect(await cursor()).toBe(5_000);
  });

  it("skips a transaction that can't be read once it's older than the blocks read again", async () => {
    await sweptFrom(0);
    chain.tokens = [
      { hash: "0xin", block: 16 },
      { hash: "0xout", block: 32, out: true },
    ];
    // 0xin won't read; 0xout still records.
    vi.mocked(recordArrivals).mockImplementation(async (_chain, hash) => {
      if (hash === "0xin") throw new Error("receipt timed out");
    });
    const said = vi.spyOn(console, "error").mockImplementation(() => {});
    await sweepNetwork("base", WALLET);
    expect(hinted()).toEqual(["0xin", "0xout"]);
    expect(said).toHaveBeenCalledWith(
      expect.stringContaining("passes 0xin"),
      expect.objectContaining({ message: "receipt timed out" }),
    );
    expect(await cursor()).toBe(4_000);
  });

  it("never passes one Auni's records can't tell yet, however old, so a deposit isn't lost", async () => {
    await sweptFrom(0);
    chain.tokens = [
      { hash: "0xin", block: 16 },
      { hash: "0xout", block: 32, out: true },
    ];
    // 0xin may be what a running bridge delivers; 0xout still records.
    vi.mocked(recordArrivals).mockImplementation(async (_chain, hash) => {
      if (hash === "0xin") throw new NotKnownYet("not recorded yet");
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const said = vi.spyOn(console, "error");
    await sweepNetwork("base", WALLET);
    expect(hinted()).toEqual(["0xin", "0xout"]);
    expect(said).not.toHaveBeenCalled();
    // Read again from it next sweep.
    expect(await cursor()).toBe(15);
  });

  it("reads one that can't be read yet again while it's among the latest blocks", async () => {
    chain.head = 500;
    chain.tokens = [
      { hash: "0xin", block: 16 },
      { hash: "0xout", block: 32, out: true },
    ];
    vi.mocked(recordArrivals).mockRejectedValueOnce(new Error("receipt not found"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const said = vi.spyOn(console, "error");
    await sweepNetwork("base", WALLET);
    // The other still records, and nothing is old enough to skip.
    expect(hinted()).toEqual(["0xin", "0xout"]);
    expect(said).not.toHaveBeenCalled();
    // Nothing read yet.
    expect(await cursor()).toBe(-1);
  });
});

describe("sweepNetwork for the chain's own coin", () => {
  it("finds each transaction that sent coin straight to the wallet, from where its balance rose", async () => {
    await sweptFrom(999);
    chain.head = 10_000;
    chain.coin = [
      { block: 2_345, units: 10n, hash: "0xsent" },
      { block: 6_001, units: 5n, hash: "0xtip" },
      // A bridge's delivery: the balance rose, but no transaction to the wallet carried it.
      { block: 7_777, units: 3n },
    ];
    await sweepNetwork("base", WALLET);
    expect(hinted()).toEqual(["0xsent", "0xtip"]);
    // Halved down to each block it rose in: a few reads a rise, not one a block.
    expect(chain.balanceReads).toBeLessThan(3 * 2 * Math.ceil(Math.log2(9_000)) + 2);
    expect(await cursor()).toBe(9_000);
  });

  it("misses coin that came in where the wallet spent more of it, which shows only in readings", async () => {
    await sweptFrom(999);
    chain.coin = [
      { block: 2_000, units: 1n, hash: "0xmasked" },
      { block: 2_001, units: -5n },
    ];
    await sweepNetwork("base", WALLET);
    expect(hinted()).toEqual([]);
    expect(chain.balanceReads).toBe(2);
  });

  it("finds tokens still where the RPC keeps no past balances", async () => {
    chain.tokens = [{ hash: "0xusdc", block: 4_500 }];
    vi.spyOn(publicClient("base"), "getBalance").mockRejectedValue(
      new InvalidParamsRpcError(new Error("historical state is not available")),
    );
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await sweepNetwork("base", WALLET);
    expect(hinted()).toEqual(["0xusdc"]);
    expect(warned).toHaveBeenCalledOnce();
    expect(await cursor()).toBe(4_000);
  });

  // Robinhood Chain's answer, as viem gives it for a balance read through a multicall: the RPC's
  // own error is the cause of a call's. Read as no answer, it failed the sweep on every pass.
  it("passes the coin search where the RPC's refusal of past state comes wrapped in a call's error", async () => {
    chain.tokens = [{ hash: "0xusdc", block: 4_500 }];
    const refused = new RpcRequestError({
      body: {},
      url: "https://rpc.mainnet.chain.robinhood.com",
      error: { code: -32000, message: "historical state 800484 is not available" },
    });
    vi.spyOn(publicClient("base"), "getBalance").mockRejectedValue(
      new CallExecutionError(refused, {}),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await sweepNetwork("base", WALLET);
    expect(hinted()).toEqual(["0xusdc"]);
    expect(await cursor()).toBe(4_000);
  });

  it("searches the blocks again next time when a busy RPC refuses a past balance", async () => {
    await sweptFrom(999);
    chain.coin = [{ block: 2_345, units: 10n, hash: "0xsent" }];
    // As mainnet.base.org answers when it's busy (probed November 2026).
    vi.spyOn(publicClient("base"), "getBalance").mockRejectedValue(
      new RpcRequestError({
        body: {},
        url: "https://mainnet.base.org",
        error: { code: -32011, message: "request limit reached" },
      }),
    );
    await expect(sweepNetwork("base", WALLET)).rejects.toThrow("request limit reached");
    expect(await cursor()).toBe(999);
  });
});

describe("sweepNetwork through an RPC's limits", () => {
  it("asks for half as many blocks while the RPC refuses a span, and reads on at what it takes", async () => {
    const arbitrum = fakeChain("arbitrum", 2_500);
    arbitrum.head = 100_000;
    await db.insert(arrivalCursors).values({ chain: "arbitrum", block: 79_999 });
    arbitrum.tokens = [{ hash: "0xlate", block: 99_000 }];
    await sweepNetwork("arbitrum", WALLET);
    const ins = arbitrum.asked.filter(({ side }) => side === "in");
    expect(ins.slice(0, 3).map(({ from, to }) => to - from + 1)).toEqual([10_000, 5_000, 2_500]);
    // Twice what it took is tried again now and then, never more.
    expect(ins.slice(3).every(({ from, to }) => to - from + 1 <= 5_000)).toBe(true);
    expect(logSpan("arbitrum")).toBeLessThanOrEqual(5_000);
    expect(hinted()).toEqual(["0xlate"]);
    expect(await cursor()).toBe(99_000);
  });

  it("widens the span again once the calls are answered, as when Monad's first RPC is back", async () => {
    // While rpc2.monad.xyz is out, rpc.monad.xyz answers for it, and refuses over 100 blocks.
    const monad = fakeChain("monad", 100);
    monad.head = 300_000;
    await transferLogs("monad", WALLET, "in", 1, 900);
    expect(logSpan("monad")).toBe(100);
    monad.rpcs[0]!.refuseOver = 10_000;
    await transferLogs("monad", WALLET, "in", 1_001, 300_000);
    expect(logSpan("monad")).toBe(10_000);
  });

  it("keeps up with the chain where its RPC serves only 100 blocks a call", async () => {
    const polygon = fakeChain("polygon", 100);
    polygon.head = 20_000;
    await db.insert(arrivalCursors).values({ chain: "polygon", block: 14_000 });
    polygon.tokens = [{ hash: "0xlate", block: 18_900 }];
    // As an earlier sweep learned it.
    await transferLogs("polygon", WALLET, "in", 1, 900);
    expect(logSpan("polygon")).toBe(100);
    await sweepNetwork("polygon", WALLET);
    expect(hinted()).toEqual(["0xlate"]);
    expect(await cursor()).toBe(19_000);
  });

  it("catches a wallet long unswept up by what it reads in half a minute", async () => {
    await sweptFrom(0);
    chain.head = 1_000_000;
    chain.msPerCall = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => chain.clock);
    chain.tokens = [{ hash: "0xlater", block: 900_000 }];
    await sweepNetwork("base", WALLET);
    expect(hinted()).toEqual([]);
    // Fifteen spans, each a second a side.
    expect(await cursor()).toBe(15 * logSpan("base"));
  });

  it("keeps what it read when a later span fails, and reads on from there next time", async () => {
    await sweptFrom(0);
    chain.head = 100_000;
    chain.tokens = [{ hash: "0xearly", block: 5_000 }];
    chain.answersFor = 4;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await sweepNetwork("base", WALLET);
    expect(hinted()).toEqual(["0xearly"]);
    expect(await cursor()).toBe(20_000);
  });
});

describe("sweepNetwork across a chain's RPCs", () => {
  // Each chain's public RPCs, as Auni asks them without an Alchemy key.
  beforeEach(() => {
    env.ALCHEMY_API_KEY = undefined;
  });
  afterEach(() => {
    env.ALCHEMY_API_KEY = "test";
  });

  it("reads Polygon as its public RPCs answer: the first refuses over 100 blocks, the second gives no answer", async () => {
    // As probed November 2026: polygon.drpc.org refuses a span over 100 blocks with code 35,
    // and polygon.gateway.tenderly.co often answers 1,000 blocks in over 15 seconds, or never.
    const polygon = fakeChain("polygon", 100);
    polygon.rpcs[0]!.refusal = () =>
      new RpcRequestError({
        body: {},
        url: "https://polygon.drpc.org",
        error: { code: 35, message: "ranges over 10000 blocks are not supported on free plan" },
      });
    polygon.rpcs[1]!.silent = true;
    polygon.head = 60_000;
    await db.insert(arrivalCursors).values({ chain: "polygon", block: 59_000 });
    polygon.tokens = [{ hash: "0xarrived", block: 59_950 }];
    await sweepNetwork("polygon", WALLET);
    expect(hinted()).toEqual(["0xarrived"]);
    expect(await cursor("polygon")).toBe(59_000);
    expect(polygon.asked.every(({ rpc }) => rpc === "https://polygon.drpc.org")).toBe(true);
  });

  it("passes a span to the next RPC when one gives no answer, and asks that one first after", async () => {
    const ink = fakeChain("ink");
    const [first, second] = eachRpc("ink").map(({ url }) => url);
    ink.rpcs[0]!.silent = true;
    ink.tokens = [{ hash: "0xin", block: 4_500 }];
    expect((await transferLogs("ink", WALLET, "in", 4_000, 5_000)).logs).toHaveLength(1);
    expect(ink.headAsked).toEqual([first, second]);
    expect(ink.asked.map(({ rpc }) => rpc)).toEqual([second]);
    ink.headAsked = [];
    ink.head = 6_000;
    await transferLogs("ink", WALLET, "in", 5_001, 6_000);
    expect(ink.headAsked).toEqual([second]);
  });

  it("never passes blocks no log RPC has reached, however far behind the head they are", async () => {
    // A log RPC 2,000 blocks behind the head answered an empty list for the latest blocks, and
    // the cursor passed a deposit in them for good (2026-11-14, run with a stand-in RPC).
    const polygon = fakeChain("polygon");
    polygon.head = 60_000;
    polygon.rpcs.forEach((rpc) => (rpc.behind = 2_000));
    await db.insert(arrivalCursors).values({ chain: "polygon", block: 55_000 });
    polygon.tokens = [{ hash: "0xdeposit", block: 58_100 }];
    await sweepNetwork("polygon", WALLET);
    expect(hinted()).toEqual([]);
    // As far as the RPC had got, and no further.
    expect(await cursor("polygon")).toBe(58_000);

    // It catches up, and the deposit is found.
    polygon.rpcs.forEach((rpc) => (rpc.behind = 0));
    polygon.head = 60_500;
    await sweepNetwork("polygon", WALLET);
    expect(hinted()).toEqual(["0xdeposit"]);
    expect(await cursor("polygon")).toBe(59_500);
  });

  it("reads what one RPC hasn't reached from the next that has", async () => {
    const ethereum = fakeChain("ethereum");
    const [first, second] = eachRpc("ethereum").map(({ url }) => url);
    ethereum.head = 60_000;
    ethereum.rpcs[0]!.behind = 2_000;
    await db.insert(arrivalCursors).values({ chain: "ethereum", block: 55_000 });
    ethereum.tokens = [
      { hash: "0xearly", block: 57_000 },
      { hash: "0xdeposit", block: 58_100 },
    ];
    await sweepNetwork("ethereum", WALLET);
    expect(hinted()).toEqual(["0xearly", "0xdeposit"]);
    expect(await cursor("ethereum")).toBe(59_000);
    // The first is asked as far as it has got, the second for the rest.
    expect(ethereum.asked.filter(({ side }) => side === "in")).toEqual([
      { from: 55_001, to: 58_000, side: "in", rpc: first },
      { from: 58_001, to: 60_000, side: "in", rpc: second },
    ]);
  });

  it("learns the span of the RPC it asks, not of the one listed first", async () => {
    const unichain = fakeChain("unichain");
    const urls = eachRpc("unichain").map(({ url }) => url);
    unichain.head = 1_000;
    // The one asked first gives no answer, and the other refuses over 100 blocks a call.
    unichain.rpcs.forEach((rpc, index) => {
      Object.defineProperty(rpc, "silent", { get: () => unichain.headAsked[0] === urls[index] });
      rpc.refuseOver = 100;
    });
    unichain.tokens = [{ hash: "0xin", block: 950 }];
    expect((await transferLogs("unichain", WALLET, "in", 1, 1_000)).logs).toHaveLength(1);
    // Halved down to what the other takes, then read at that.
    const spans = unichain.asked.map(({ from, to }) => to - from + 1);
    expect(spans.slice(0, 8)).toEqual([1_000, 1_000, 1_000, 1_000, 625, 312, 156, 100]);
    expect(spans.slice(8).every((span) => span <= 200)).toBe(true);
    expect(new Set(unichain.asked.map(({ rpc }) => rpc))).toEqual(
      new Set(urls.filter((url) => url !== unichain.headAsked[0])),
    );
  });

  it("asks every RPC again for each span, whichever failed the span before", async () => {
    const ethereum = fakeChain("ethereum");
    const urls = eachRpc("ethereum").map(({ url }) => url);
    ethereum.head = 20_000;
    // The one asked first gives no answer until the other has served a span; then the other
    // gives none, and the first answers.
    const served = () => ethereum.asked.length > 1;
    ethereum.rpcs.forEach((rpc, index) =>
      Object.defineProperty(rpc, "silent", {
        get: () => (ethereum.headAsked[0] === urls[index] ? !served() : served()),
      }),
    );
    ethereum.tokens = [
      { hash: "0xearly", block: 500 },
      { hash: "0xlate", block: 15_000 },
    ];
    const { logs, through } = await transferLogs("ethereum", WALLET, "in", 1, 20_000);
    expect(logs.map(({ hash }) => hash)).toEqual(["0xearly", "0xlate"]);
    expect(through).toBe(20_000);
    expect(new Set(ethereum.asked.map(({ rpc }) => rpc)).size).toBe(2);
  });

  it("fails only when no RPC answers, and then reads the span again next sweep", async () => {
    const unichain = fakeChain("unichain");
    unichain.rpcs.forEach((rpc) => (rpc.silent = true));
    await db.insert(arrivalCursors).values({ chain: "unichain", block: 3_999 });
    await expect(sweepNetwork("unichain", WALLET)).rejects.toThrow(TimeoutError);
    expect(await cursor("unichain")).toBe(3_999);
  });
});

describe("sweepNetwork through spam", () => {
  const BOUGHT = "0x4444444444444444444444444444444444444444";

  it("hands the recorder only coin, cash, what was bought and tokens the lists know, however much spam came in", async () => {
    await sweptFrom(0);
    const action = await insertAction({ status: "done" });
    await db.insert(fills).values({
      actionId: action.id,
      chain: "base",
      instrument: BOUGHT,
      side: "buy",
      quantity: "1",
      usdValue: "1",
    });
    chain.coin = [{ block: 10, units: 1n, hash: "0xeth" }];
    chain.tokens = [
      { hash: "0xusdc", block: 11 },
      { hash: "0xbought", block: 12, token: BOUGHT },
      { hash: "0xlink", block: 13, token: LINK },
      ...Array.from({ length: 40 }, (_, index) => ({
        hash: `0xspam${index}`,
        block: 100 + index,
        token: `0x${index.toString(16).padStart(40, "5")}`,
      })),
    ];
    // Spam priced from a pool its sender seeded is spam all the same.
    vi.mocked(tokenPrices).mockImplementation(async (ids) => ({
      prices: new Map(ids.map((id) => [id, { price: 15 }] as const)),
      complete: true,
    }));
    await sweepNetwork("base", WALLET);
    expect(hinted()).toEqual(["0xeth", "0xusdc", "0xbought", "0xlink"]);
    // All asked about together, once, and no price asked for at all.
    expect(listings).toHaveBeenCalledTimes(1);
    expect(tokenPrices).not.toHaveBeenCalled();
    // Each spam token its one row.
    expect(await db.select().from(otherTokens)).toHaveLength(40);
    expect(await cursor()).toBe(4_000);
  });

  it("sweeps nothing while the lists can't be read, rather than pass a token's deposits by", async () => {
    chain.tokens = [{ hash: "0xlink", block: 4_013, token: LINK }];
    vi.mocked(listings).mockRejectedValue(new Error("CoinGecko unavailable"));
    await expect(sweepNetwork("base", WALLET)).rejects.toThrow();
    expect(hinted()).toEqual([]);
    expect(await cursor()).toBeUndefined();
  });
});

describe("sweepNetwork on Solana", () => {
  const SOL_WALLET = "Wa11et1111111111111111111111111111111111111";
  /** The wallet's token accounts: USDC, BONK, and 40 of spam anyone could have made. */
  const accounts = [
    { pubkey: "UsdcAccount", mint: NETWORKS.solana.usdc },
    { pubkey: "BonkAccount", mint: BONK },
    ...Array.from({ length: 40 }, (_, index) => ({
      pubkey: `SpamAccount${index}`,
      mint: `SpamMint${index}`,
    })),
  ];
  let listed: string[] = [];

  beforeEach(() => {
    listed = [];
    vi.mocked(solanaRpc).mockImplementation((async (method: string, params: unknown[]) => {
      if (method === "getSlot") return 5_000;
      if (method === "getTokenAccountsByOwner") {
        // Every account under the classic program, none under Token-2022.
        const [, { programId }] = params as [string, { programId: string }];
        if (programId !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") return { value: [] };
        return {
          value: accounts.map(({ pubkey, mint }) => ({
            pubkey,
            account: { data: { parsed: { info: { mint, tokenAmount: { amount: "1" } } } } },
          })),
        };
      }
      if (method === "getSignaturesForAddress") {
        const [address] = params as [string];
        listed.push(address);
        return [{ signature: `sig-${address}`, slot: 100, err: null }];
      }
      throw new Error(`unexpected ${method}`);
    }) as never);
  });

  it("lists the signatures of only the wallet and its accounts of cash or a token the lists know, however much spam it holds", async () => {
    await sweepNetwork("solana", SOL_WALLET);
    expect(listed).toEqual([SOL_WALLET, "UsdcAccount", "BonkAccount"]);
    // The mints asked about together, once, and no price asked for.
    expect(listings).toHaveBeenCalledTimes(1);
    expect(tokenPrices).not.toHaveBeenCalled();
    expect(hinted().toSorted()).toEqual(
      ["sig-BonkAccount", "sig-UsdcAccount", `sig-${SOL_WALLET}`].toSorted(),
    );
    // Each spam mint held is its one row.
    expect(await db.select().from(otherTokens)).toHaveLength(40);
  });

  it("sweeps nothing while the lists can't be read, rather than pass a token's deposits by", async () => {
    vi.mocked(listings).mockRejectedValue(new Error("Jupiter unavailable"));
    await expect(sweepNetwork("solana", SOL_WALLET)).rejects.toThrow();
    expect(hinted()).toEqual([]);
    expect(await cursor()).toBeUndefined();
  });
});

describe("sweepNetwork through a Solana flood", () => {
  const SOL_WALLET = "Wa11et1111111111111111111111111111111111111";
  /** Every signature naming the wallet, newest first. */
  let signatures: { signature: string; slot: number }[] = [];
  /** Each listing asked of the wallet: the signature it began before, if any. */
  let pages: (string | undefined)[] = [];

  beforeEach(() => {
    pages = [];
    vi.mocked(solanaRpc).mockImplementation((async (method: string, params: unknown[]) => {
      if (method === "getSlot") return 100_000;
      if (method === "getTokenAccountsByOwner") return { value: [] };
      if (method === "getSignaturesForAddress") {
        const [, { limit, before }] = params as [string, { limit: number; before?: string }];
        pages.push(before);
        const start = before
          ? signatures.findIndex(({ signature }) => signature === before) + 1
          : 0;
        return signatures.slice(start, start + limit).map((tx) => ({ ...tx, err: null }));
      }
      throw new Error(`unexpected ${method}`);
    }) as never);
  });

  /** `count` transactions naming the wallet, one a slot from slot 1,000, oldest first. */
  function history(count: number): string[] {
    const oldestFirst = Array.from({ length: count }, (_, index) => `sig${index}`);
    signatures = oldestFirst
      .map((signature, index) => ({ signature, slot: 1_000 + index }))
      .reverse();
    return oldestFirst;
  }

  it("records a wallet's few transactions in one sweep", async () => {
    const oldestFirst = history(20);
    await sweepNetwork("solana", SOL_WALLET);
    expect(pages).toEqual([undefined]);
    expect(hinted()).toEqual(oldestFirst);
    expect(await cursor()).toBe(99_000);
  });

  it("lists a flood a few pages a sweep, recording nothing until it reaches the cursor", async () => {
    const oldestFirst = history(3_500);
    await sweepNetwork("solana", SOL_WALLET);
    // The newest three thousand; the oldest five hundred are still unread, so nothing is passed.
    expect(pages).toHaveLength(3);
    expect(hinted()).toEqual([]);
    expect(await cursor()).toBe(-1);
    // The next sweep reads on from where it stopped, and records from the oldest.
    pages = [];
    await sweepNetwork("solana", SOL_WALLET);
    expect(pages).toEqual(["sig500"]);
    expect(hinted()).toEqual(oldestFirst.slice(0, 50));
    expect(await cursor()).toBe(1_049);
    // Sweep by sweep, every one is recorded once, oldest first.
    for (let sweeps = 0; hinted().length < oldestFirst.length && sweeps < 100; sweeps += 1)
      await sweepNetwork("solana", SOL_WALLET);
    expect(hinted()).toEqual(oldestFirst);
    await sweepNetwork("solana", SOL_WALLET);
    expect(await cursor()).toBe(99_000);
  });

  it("reads on past the pages a sweep lists while they all sit in the slot it begins at", async () => {
    await db.insert(arrivalCursors).values({ chain: "solana", block: 4_999 });
    // A slot of 3,500 transactions naming the wallet, then one after it.
    signatures = [
      { signature: "after", slot: 5_001 },
      ...Array.from({ length: 3_500 }, (_, index) => ({ signature: `flood${index}`, slot: 5_000 })),
    ];
    await sweepNetwork("solana", SOL_WALLET);
    expect(pages).toHaveLength(4);
    expect(await cursor()).toBe(5_000);
  });
});
