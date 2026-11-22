import { describe, expect, it, vi } from "vitest";

import { pad, toHex, type Hex } from "viem";

import { solanaRpc } from "./chains.ts";
import { howItCame } from "./how-it-came.ts";
import { readTransfers, TRANSFER_TOPIC } from "./transfers.ts";

const WALLET = "0x8f5aa7eb7e9c856ac75ceccba3bc80dd2a87b626";
const USDCE = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
const ACROSS = "0x0f7ae28de1c8532170ad4ee566b5801485c13a0e";
const POLYMARKET = "0x259608bc7bdd8d7166a01764c53fc1294958a695";
const STRANGER = "0xadfc1c5713d6100206f511caa628a52672e87150";

/** This user's USDC.e on Polygon: two bridges in, then on to Polymarket and someone else. */
const moves = [
  { from: ACROSS, to: WALLET, micros: 5_005_041, block: 8_000 },
  { from: ACROSS, to: WALLET, micros: 5_006_583, block: 9_000 },
  { from: WALLET, to: STRANGER, micros: 6_000_000, block: 31_000 },
  { from: WALLET, to: POLYMARKET, micros: 3_347_325, block: 32_000 },
];
const HEAD = 40_000;
const asked: { fromBlock: number; toBlock: number; address: string; side: "in" | "out" }[] = [];

const client = {
  getBlockNumber: async () => BigInt(HEAD),
  request: vi.fn(
    async ({
      method,
      params,
    }: {
      method: string;
      params?: [{ fromBlock: Hex; toBlock: Hex; address: string; topics: (Hex | null)[] }];
    }) => {
      if (method === "eth_blockNumber") return toHex(HEAD);
      if (!params) throw new Error(`unexpected ${method}`);
      const [query] = params;
      const [fromBlock, toBlock] = [Number(query.fromBlock), Number(query.toBlock)];
      const side = query.topics.length === 3 ? "in" : "out";
      asked.push({ fromBlock, toBlock, address: query.address, side });
      return moves
        .filter(
          ({ to, block }) =>
            block >= fromBlock && block <= toBlock && (to === WALLET) === (side === "in"),
        )
        .map(({ from, to, micros, block }) => ({
          address: USDCE,
          topics: [TRANSFER_TOPIC, pad(from as Hex), pad(to as Hex)],
          data: pad(toHex(micros)),
          blockNumber: toHex(block),
          transactionHash: `0x${block}`,
        }));
    },
  ),
  readContract: async () => 6,
  getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
    number: blockNumber,
    // One block a minute from the first of September.
    timestamp: BigInt(Date.parse("2026-09-01T00:00:00.000Z") / 1_000) + blockNumber * 60n,
  }),
};
vi.mock("./chains.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  publicClient: () => client,
  eachRpc: () => [{ url: "https://polygon.example", client }],
  solanaRpc: vi.fn(),
}));
vi.mock("./transfers.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readTransfers: vi.fn(),
}));
// Across names its own contracts as it is; Polymarket's deposit wallet for this owner is POLYMARKET.
vi.mock(import("../apps/registry.ts"), async (original) => {
  const registry = await original();
  return {
    ...registry,
    apps: () =>
      registry
        .apps()
        .map((one) =>
          one.about.id === "polymarket"
            ? { ...one, addresses: async () => new Map([[POLYMARKET, "their Polymarket wallet"]]) }
            : one,
        ),
  };
});

const at = (block: number) => new Date(Date.parse("2026-09-01T00:00:00.000Z") + block * 60_000);

describe("howItCame", () => {
  it("tells a token's latest moves newest first, naming Across and their Polymarket wallet", async () => {
    expect(await howItCame("polygon", WALLET, USDCE)).toEqual([
      { at: at(32_000), amount: "-3.347325", who: "their Polymarket wallet" },
      { at: at(31_000), amount: "-6", who: "0xadfc…7150" },
      { at: at(9_000), amount: "5.006583", who: "an Across bridge" },
      { at: at(8_000), amount: "5.005041", who: "an Across bridge" },
    ]);
    // Only this token's Transfer logs, each way, read back from the head a span at a time.
    expect(asked.every(({ address }) => address === USDCE)).toBe(true);
    expect(asked.filter(({ side }) => side === "in").map(({ fromBlock }) => fromBlock)).toEqual([
      30_001, 20_001, 10_001, 1, 0,
    ]);
  });

  it("reads a Solana transaction that touched two of its accounts once", async () => {
    const mint = "So1anaMint1111111111111111111111111111111";
    vi.mocked(solanaRpc).mockImplementation(async (method: string) =>
      method === "getTokenAccountsByOwner"
        ? { value: [{ pubkey: "account-a" }, { pubkey: "account-b" }] }
        : [{ signature: "both", slot: 7, err: null }],
    );
    vi.mocked(readTransfers).mockResolvedValue({
      at: new Date("2026-10-01T00:00:00.000Z"),
      block: 7,
      transfers: [
        {
          position: mint,
          instrument: mint,
          decimals: 6,
          baseUnits: 2_500_000n,
          counterparty: STRANGER,
        },
      ],
      walletSigned: false,
      closedAccounts: [],
    });
    expect(await howItCame("solana", "wallet", mint)).toEqual([
      { at: new Date("2026-10-01T00:00:00.000Z"), amount: "2.5", who: "0xadfc…7150" },
    ]);
    expect(readTransfers).toHaveBeenCalledOnce();
  });
});
