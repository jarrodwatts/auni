import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  type Address,
  type Hex,
  type Log,
  type TransactionReceipt,
} from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import activityFixture from "./fixtures/activity-redeem-v2.json";
import { fillIdentity } from "../../money/fill-key.ts";
import { publicClient } from "../../money/chains.ts";
import { CONTRACTS } from "./http.ts";
import { outcomeKey } from "./keys.ts";
import { resolveMarket } from "./markets.ts";
import { polymarketPayouts } from "./payouts.ts";

const OWNER = "0x1111111111111111111111111111111111111111";
const WALLET: Address = "0x2222222222222222222222222222222222222222";
const CONDITION = `0x${"ab".repeat(32)}` as const;
const YES = 111_111_111_111n;
const NO = 222_222_222_222n;
/** Real pages of Polymarket's activity (fixtures/), and the v1 address it retired. */
const recorded = activityFixture as {
  pages: readonly {
    data: { transaction_hash: string }[];
    pagination: { next_cursor: string | null };
  }[];
  v1: unknown;
};
const REDEEMED = recorded.pages[0]!.data[0]!.transaction_hash as Hex;

vi.mock("./wallet.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  depositWallet: async () => ({ address: WALLET, deployed: true }),
}));
vi.mock("./markets.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveMarket: vi.fn(),
}));

const events = parseAbi([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  "event Redemption(address indexed from, uint256 indexed positionId, uint256 payout)",
  "event BinaryRedemption(address indexed from, bytes32 indexed conditionId, uint256 payout)",
]);

function log(address: Address, topics: readonly (Hex | Hex[] | null)[], data: Hex): Log {
  return { address, topics, data } as unknown as Log;
}

/** The AutoRedeemer paying out the wallet's original shares of the market, as it does on chain. */
function binaryRedemption(amounts: readonly [bigint, bigint], payout: bigint): Log[] {
  return [
    log(
      CONTRACTS.conditionalTokens,
      encodeEventTopics({
        abi: events,
        eventName: "TransferBatch",
        args: { operator: CONTRACTS.autoRedeemer, from: WALLET, to: CONTRACTS.autoRedeemer },
      }),
      encodeAbiParameters(
        [{ type: "uint256[]" }, { type: "uint256[]" }],
        [[YES, NO], [...amounts]],
      ),
    ),
    log(
      CONTRACTS.autoRedeemer,
      encodeEventTopics({
        abi: events,
        eventName: "BinaryRedemption",
        args: { from: WALLET, conditionId: CONDITION },
      }),
      encodeAbiParameters([{ type: "uint256" }], [payout]),
    ),
  ];
}

/** The same for a Protocol V2 position, which it hands its app to redeem. */
function v2Redemption(position: bigint, amount: bigint, payout: bigint): Log[] {
  return [
    log(
      CONTRACTS.positionManager,
      encodeEventTopics({
        abi: events,
        eventName: "TransferSingle",
        args: { operator: CONTRACTS.autoRedeemer, from: WALLET, to: CONTRACTS.exchangeV3 },
      }),
      encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [position, amount]),
    ),
    log(
      CONTRACTS.autoRedeemer,
      encodeEventTopics({
        abi: events,
        eventName: "Redemption",
        args: { from: WALLET, positionId: position },
      }),
      encodeAbiParameters([{ type: "uint256" }], [payout]),
    ),
  ];
}

let logs: Log[] = [];
let asked: URL[] = [];
/** What the data API lists the wallet holding (see listedPositions). */
let listed: Record<string, unknown>[] = [];

/** The data API as recorded: each cursor answers the page it was minted for, the last an empty page. */
function dataApi(input: string | URL | Request): Response {
  const url = new URL(input instanceof Request ? input.url : input);
  asked.push(url);
  if (url.pathname === "/v2/positions")
    return Response.json({ data: listed, pagination: { next_cursor: null } });
  const cursor = url.searchParams.get("cursor");
  const page = cursor
    ? recorded.pages.find(
        (_, index) => recorded.pages[index - 1]?.pagination.next_cursor === cursor,
      )
    : recorded.pages[0];
  return Response.json(page ?? { data: [], pagination: { next_cursor: null } });
}

beforeEach(() => {
  vi.restoreAllMocks();
  asked = [];
  listed = [];
  logs = binaryRedemption([10_000_000n, 0n], 10_000_000n);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => dataApi(input));
  // Only the first recorded redemption touched this wallet's shares; the others read as nothing.
  vi.spyOn(publicClient("polygon"), "getTransactionReceipt").mockImplementation(
    async ({ hash }) =>
      ({ status: "success", logs: hash === REDEEMED ? logs : [] }) as unknown as TransactionReceipt,
  );
  vi.mocked(resolveMarket).mockResolvedValue({
    question: "Will it rain?",
    tokens: [
      { tokenId: YES, outcome: "Yes", winner: true },
      { tokenId: NO, outcome: "No", winner: false },
    ],
  } as unknown as Awaited<ReturnType<typeof resolveMarket>>);
});

/** The fills' open outcomes, by fillIdentity. */
const open = (...tokens: bigint[]) =>
  new Set(tokens.map((token) => fillIdentity(outcomeKey(token))));
const SHARE = 10n ** 12n;

describe("reading what Polymarket paid out", () => {
  it("reads a redemption's payout from its transaction: what it burned and paid", async () => {
    expect(await polymarketPayouts(OWNER, open(YES), 0, new Set())).toEqual([
      {
        hash: REDEEMED,
        chain: "polygon",
        markets: [
          {
            question: "Will it rain?",
            paidMicros: 10_000_000n,
            shares: [
              { key: outcomeKey(YES), burned: 10_000_000n * SHARE, paidMicros: 10_000_000n },
            ],
          },
        ],
      },
    ]);
  });

  it("pays losing shares nothing", async () => {
    logs = binaryRedemption([0n, 5_000_000n], 0n);
    const [payout] = await polymarketPayouts(OWNER, open(NO), 0, new Set());
    expect(payout?.markets).toEqual([
      {
        question: "Will it rain?",
        paidMicros: 0n,
        shares: [{ key: outcomeKey(NO), burned: 5_000_000n * SHARE, paidMicros: 0n }],
      },
    ]);
  });

  it("reads a V2 payout of one position", async () => {
    logs = v2Redemption(YES, 10_000_000n, 10_000_000n);
    const [payout] = await polymarketPayouts(OWNER, open(YES), 0, new Set());
    expect(payout?.markets[0]?.shares).toEqual([
      { key: outcomeKey(YES), burned: 10_000_000n * SHARE, paidMicros: 10_000_000n },
    ]);
  });

  it("reads a bet the market resolved against, which nobody redeems, as a payout of nothing", async () => {
    // Live: the 8PM bet's 1.9607 Up shares lost, and sat at Polymarket "REDEEMABLE" for good
    // (finding 99). The data API lists them worthless; the market names its winner.
    const lost = (token: bigint, fields: Record<string, unknown> = {}) => ({
      token_id: String(token),
      condition_id: CONDITION,
      current_size: 1.9607,
      current_value: 0,
      redeemable: true,
      ...fields,
    });
    logs = [];
    listed = [lost(NO)];
    expect(await polymarketPayouts(OWNER, open(NO), 0, new Set())).toEqual([
      {
        hash: null,
        chain: "polygon",
        markets: [
          {
            question: "Will it rain?",
            paidMicros: 0n,
            shares: [{ key: outcomeKey(NO), burned: 1_960_700n * SHARE, paidMicros: 0n }],
          },
        ],
      },
    ]);
    expect(resolveMarket).toHaveBeenCalledWith(CONDITION);

    // Never one still worth something, one the market didn't resolve against, or one Auni's
    // fills don't hold.
    for (const position of [
      lost(NO, { current_value: 0.5 }),
      lost(NO, { redeemable: false }),
      lost(YES),
    ]) {
      listed = [position];
      expect(await polymarketPayouts(OWNER, open(NO, YES), 0, new Set())).toEqual([]);
    }
    listed = [lost(NO)];
    expect(await polymarketPayouts(OWNER, open(YES), 0, new Set())).toEqual([]);
    // Nor before the market names a winner.
    vi.mocked(resolveMarket).mockResolvedValue({
      question: "Will it rain?",
      tokens: [
        { tokenId: YES, outcome: "Yes", winner: false },
        { tokenId: NO, outcome: "No", winner: false },
      ],
    } as unknown as Awaited<ReturnType<typeof resolveMarket>>);
    expect(await polymarketPayouts(OWNER, open(NO), 0, new Set())).toEqual([]);
  });

  it("passes by a redemption already recorded", async () => {
    expect(await polymarketPayouts(OWNER, open(YES), 0, new Set([REDEEMED]))).toEqual([]);
  });

  it("passes by a redemption of shares the fills don't hold", async () => {
    // The wallet's Yes shares came from elsewhere; Auni's No shares are still there.
    expect(await polymarketPayouts(OWNER, open(NO), 0, new Set())).toEqual([]);
  });

  it("lists redemptions from the data API's v2 activity, page by page by its cursor", async () => {
    await polymarketPayouts(OWNER, open(YES), 1_700_000_000_000, new Set());
    expect(asked.map((url) => url.pathname)).toEqual([
      "/v2/activity",
      "/v2/activity",
      "/v2/activity",
      "/v2/positions",
    ]);
    expect(Object.fromEntries(asked[0]!.searchParams)).toEqual({
      user: WALLET,
      type: "REDEEM",
      start: "1700000000",
      sort_by: "TIMESTAMP",
      sort_direction: "ASC",
      limit: "1000",
    });
    // Each page asks again with every filter, as a cursor only works beside the ones it was minted with.
    expect(asked[1]!.searchParams.get("cursor")).toBe(recorded.pages[0]!.pagination.next_cursor);
    expect(asked[1]!.searchParams.get("type")).toBe("REDEEM");
  });

  it("asks for the whole history from the start, never the API's three-year default", async () => {
    await polymarketPayouts(OWNER, open(YES), 0, new Set());
    expect(asked[0]!.searchParams.get("start")).toBe("1");
  });

  it("fails in the API's own words when it refuses, as it did retiring v1", async () => {
    vi.mocked(fetch).mockImplementation(async () => Response.json(recorded.v1, { status: 410 }));
    await expect(polymarketPayouts(OWNER, open(YES), 0, new Set())).rejects.toThrow(
      /HTTP 410.*Data API v1 has been retired/u,
    );
  });
});
