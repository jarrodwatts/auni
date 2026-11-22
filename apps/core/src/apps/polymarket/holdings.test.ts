import type { Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { publicClient } from "../../money/chains.ts";
import { CONTRACTS } from "./http.ts";
import { readPolymarket } from "./holdings.ts";

const OWNER: Address = "0x1111111111111111111111111111111111111111";
const WALLET: Address = "0x2222222222222222222222222222222222222222";
// An original (conditional tokens) id is a hash, so it has the bits a Protocol V2 id leaves clear.
const SOLD = BigInt(`0x${"ab".repeat(32)}`);
const KEPT = BigInt(`0x${"cd".repeat(32)}`);
// A Protocol V2 id: those bits clear.
const V2 = 12_345n;

vi.mock("./wallet.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  depositWallet: async () => ({ address: WALLET, deployed: true }),
}));

/** Polymarket's data API, as it answers a while after a sale: still listing what was sold. */
function positions(
  rows: readonly { id: bigint; size: number; value: number; redeemable?: boolean }[],
) {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      data: rows.map((row) => ({
        token_id: String(row.id),
        current_size: row.size,
        current_value: row.value,
        title: `Market ${row.id}`,
        outcome: "Yes",
        avg_price: 0.5,
        redeemable: row.redeemable ?? false,
      })),
      pagination: { next_cursor: null },
    }),
  );
}

/** Polygon as it is now: `shares` held in each share contract by token id, and $2 of pUSD. */
function chain(shares: ReadonlyMap<string, bigint>) {
  vi.spyOn(publicClient("polygon"), "readContract").mockImplementation((async (call: {
    address: Address;
    functionName: string;
    args: readonly unknown[];
  }) => {
    if (call.functionName !== "balanceOf") throw new Error(`unexpected ${call.functionName}`);
    if (call.args.length === 1) return call.address === CONTRACTS.pusd ? 2_000_000n : 0n;
    const [holder, id] = call.args as [Address, bigint];
    expect(holder).toBe(WALLET);
    return shares.get(`${call.address}:${id}`) ?? 0n;
  }) as never);
}

afterEach(() => vi.restoreAllMocks());

describe("readPolymarket", () => {
  it("counts the shares the chain holds, not the ones the data API hasn't caught up on", async () => {
    positions([
      { id: SOLD, size: 1.6919, value: 1.49 },
      { id: KEPT, size: 4, value: 2 },
      { id: V2, size: 10, value: 3 },
    ]);
    chain(
      new Map([
        [`${CONTRACTS.conditionalTokens}:${KEPT}`, 3_000_000n],
        [`${CONTRACTS.positionManager}:${V2}`, 10_000_000n],
      ]),
    );
    const held = await readPolymarket(OWNER);
    expect(held.map((row) => [row.instrument, row.baseUnits, row.usdValue ?? null])).toEqual([
      ["collateral", 2_000_000n, null],
      // Three of the four shares the data API lists, at its price of 50c.
      [String(KEPT), 3_000_000_000_000_000_000n, "1.50"],
      [String(V2), 10_000_000_000_000_000_000n, "3.00"],
    ]);
  });

  it("leaves out shares a market resolved against, and keeps a win not yet paid out", async () => {
    // Live: a losing bet's 1.9607 shares sat in the portfolio for good, as Polymarket never
    // redeems shares that pay nothing (finding 99).
    positions([
      { id: SOLD, size: 1.9607, value: 0, redeemable: true },
      { id: KEPT, size: 4, value: 4, redeemable: true },
    ]);
    chain(
      new Map([
        [`${CONTRACTS.conditionalTokens}:${SOLD}`, 1_960_700n],
        [`${CONTRACTS.conditionalTokens}:${KEPT}`, 4_000_000n],
      ]),
    );
    const held = await readPolymarket(OWNER);
    expect(held.map((row) => [row.instrument, row.usdValue ?? null])).toEqual([
      ["collateral", null],
      [String(KEPT), "4.00"],
    ]);
  });
});
