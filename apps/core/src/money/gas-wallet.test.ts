import { describe, expect, it, vi } from "vitest";

import { appById, theWallet } from "../apps/registry.ts";
import { ownGas } from "./gas.ts";

// What a send costs is asked of the chain as the wallet would send it, and the wallet says how
// (WalletProvider.asSent). With that said by nobody, ownGas answers null for every send, and
// then no card is refused for want of the chain's coin, no card shows a network fee, and none
// buys the coin (fee-coin.ts): all of it switched off with every other test still passing. So
// this asks through the real door, core's wallets.ts and the wallet app Auni uses by default,
// with only the chain stood in.

const gwei = (n: number) => BigInt(Math.round(n * 1e9));
const balance = vi.hoisted(() => ({ wei: 0n }));
vi.mock("./chains.ts", async (original) => ({
  ...(await original<object>()),
  evmClient: () => ({
    chain: { name: "Monad", nativeCurrency: { symbol: "MON" } },
    estimateGas: async () => 72_594n,
    simulateBlocks: async () => [{ calls: [{ gasUsed: 90_742n }] }],
    getFeeHistory: async () => ({ reward: [[gwei(2)]], baseFeePerGas: [gwei(100)] }),
    getBalance: async () => balance.wei,
  }),
}));

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const transfer = [{ to: "0x2222222222222222222222222222222222222222", data: "0x01" }];

describe("what a send costs, asked through the wallet Auni uses by default", () => {
  it("is the wallet that holds the owner's own keys, which says how it sends", () => {
    expect(theWallet()).toBe(appById("local-key")?.wallet);
    expect(theWallet().asSent).toBeTypeOf("function");
  });

  it("says a send the wallet can't pay for is short, and by how much, before any card", async () => {
    balance.wei = 0n;
    const gas = await ownGas(143, OWNER, transfer);
    // A limit a quarter over the estimate, held at the fee cap of 202 gwei.
    expect(gas?.lacks).toBe(90_742n * gwei(202));
    expect(gas?.short).toContain("Too little MON for gas");
  });

  it("says what a send it can pay for costs", async () => {
    balance.wei = 10n ** 18n;
    expect(await ownGas(143, OWNER, transfer)).toEqual({ short: null, fee: 90_742n * gwei(102) });
  });
});
