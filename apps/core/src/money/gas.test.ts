import { afterEach, describe, expect, it, vi } from "vitest";

import type { EvmSend, EvmTx } from "./recipe.ts";
import { Refused } from "./refused.ts";
import { assertOwnGas, ownGas } from "./gas.ts";

// No chain answers unless a test stands one in.
const chain = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("./chains.ts", async (original) => ({
  ...(await original()),
  evmClient: () => {
    if (!chain.client) throw new Error("No chain in this test.");
    return chain.client;
  },
}));
// The wallet of these tests sends one call as built, and a list as the one send a test gives it.
const wallet = vi.hoisted(() => ({ list: null as EvmSend | null }));
vi.mock("./wallets.ts", () => ({
  asSent: async (_chainId: number, _owner: string, txs: readonly EvmTx[]) =>
    txs.length === 1
      ? { to: txs[0]!.to, data: txs[0]!.data, value: BigInt(txs[0]!.value ?? "0") }
      : wallet.list,
}));

const ROUTER = "0x2222222222222222222222222222222222222222";
const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const gwei = (n: number) => BigInt(Math.round(n * 1e9));

afterEach(() => {
  chain.client = null;
  wallet.list = null;
});

// Ethereum as it was for a sale of most of a wallet's ETH: a deposit the node estimates at
// 395,500 gas and that uses 316,400, at a 0.06 gwei base fee and a 0.01 gwei tip, from a wallet
// holding 0.000328 ETH.
const ethereum = (balance: bigint) => ({
  chain: { name: "Ethereum", nativeCurrency: { symbol: "ETH" } },
  estimateGas: vi.fn(async (_call: unknown) => 395_500n),
  simulateBlocks: vi.fn(async (_blocks: unknown) => [{ calls: [{ gasUsed: 316_400n }] }]),
  getFeeHistory: async () => ({ reward: [[gwei(0.01)]], baseFeePerGas: [gwei(0.06)] }),
  getBalance: async () => balance,
});

/**
 * Monad as it was on 2026-11-13 for a USDC transfer: the node estimates it at 72,594 gas, and
 * since Monad charges a send for its whole gas limit, its simulation reports the limit a call
 * was given as the gas it used, and the block's 150,000,000 for a call given none.
 */
const monad = (balance: bigint) => ({
  chain: { name: "Monad", nativeCurrency: { symbol: "MON" } },
  estimateGas: async () => 72_594n,
  simulateBlocks: async ({ blocks }: { blocks: { calls: { gas?: bigint }[] }[] }) => [
    { calls: blocks[0]!.calls.map(({ gas }) => ({ gasUsed: gas ?? 150_000_000n })) },
  ],
  getFeeHistory: async () => ({ reward: [[gwei(2)]], baseFeePerGas: [gwei(100)] }),
  getBalance: async () => balance,
});
const MON = 10n ** 18n;

describe("ownGas", () => {
  const held = 328_298_166_541_078n;
  // The start of it, which is all some places keep of an error (see settledOutcome).
  const told = (short: string | null | undefined) => `Nothing was sent. ${short}`.slice(0, 160);

  it("names the most of the coin a send of it can take and still pay its gas", async () => {
    chain.client = ethereum(held);
    const sale = [{ to: ROUTER, data: "0x01", value: (28n * 10n ** 13n).toString() }];
    const gas = await ownGas(1, OWNER, sale);
    expect(gas?.short).toContain(
      "needs about 0.00006426875 ETH on hand for gas, beyond the 0.00028 ETH it sends",
    );
    // What it holds, less the gas and a quarter's room for fees to rise before the tap.
    expect(told(gas?.short)).toContain(
      "send at most about 0.000247962229041078 ETH and still pay it, or, if that is a set price, bridge more ETH there first.",
    );
    // That much fits.
    const less = [{ ...sale[0]!, value: "247962229041078" }];
    expect((await ownGas(1, OWNER, less))?.short).toBeNull();
  });

  it("says to bring the coin there when what it sends isn't the coin", async () => {
    chain.client = ethereum(10n ** 13n);
    const gas = await ownGas(1, OWNER, [{ to: ROUTER, data: "0x01" }]);
    expect(told(gas?.short)).toContain(
      "bridge a few dollars of their cash there as ETH first, then propose this again.",
    );
    expect(gas?.short).not.toContain("send at most");
    expect(gas?.short).not.toContain("beyond");
  });

  it("says to bring the coin there when even sending none of it couldn't pay the gas", async () => {
    chain.client = ethereum(10n ** 13n);
    const gas = await ownGas(1, OWNER, [{ to: ROUTER, data: "0x01", value: "1000" }]);
    expect(gas?.short).toContain("bridge a few dollars of their cash there as ETH first");
  });

  it("shows the fee the calls use, at this block's fee and the tip", async () => {
    chain.client = ethereum(held);
    const gas = await ownGas(1, OWNER, [{ to: ROUTER, data: "0x01" }]);
    expect(gas).toEqual({ short: null, fee: 316_400n * gwei(0.07) });
  });

  it("asks a chain that charges a send for its whole limit for no more than the send will", async () => {
    // The wallet a real buy was refused from: 69 MON, told a transfer needed about 50.
    chain.client = monad(69n * MON);
    const transfer = [{ to: ROUTER, data: "0x01" }];
    // A limit of 90,742 (a quarter over the estimate), charged whole at 102 gwei.
    expect(await ownGas(143, OWNER, transfer)).toEqual({ short: null, fee: 90_742n * gwei(102) });
    // It must hold that limit at the fee cap, 202 gwei: about 0.018 MON.
    chain.client = monad(MON / 100n);
    expect((await ownGas(143, OWNER, transfer))?.short).toContain(
      "The wallet holds 0.01 MON on Monad, and this needs about 0.018329884 MON on hand for gas.",
    );
    chain.client = monad(MON / 50n);
    expect((await ownGas(143, OWNER, transfer))?.short).toBeNull();
    // The buy itself, an approval and a swap as one send, fits the 69 MON it was refused from.
    chain.client = monad(69n * MON);
    wallet.list = { to: OWNER, data: "0xba7c", value: 0n };
    const buy = [...transfer, { to: ROUTER, data: "0x02" }];
    expect(await ownGas(143, OWNER, buy)).toEqual({ short: null, fee: 90_742n * gwei(102) });
  });

  const CODE = "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B";
  const list = [
    { to: ROUTER, data: "0x01" },
    { to: ROUTER, data: "0x02", value: "1000" },
  ];

  it("costs a list as the one transaction the wallet sends, with nothing signed", async () => {
    const client = ethereum(held);
    chain.client = client;
    wallet.list = { to: OWNER, data: "0xba7c", value: 0n, delegates: CODE };
    const gas = await ownGas(1, OWNER, list);
    // Estimated as if the account ran the code the send puts it under, by a state override.
    const code = `0xef0100${CODE.slice(2).toLowerCase()}`;
    expect(client.estimateGas).toHaveBeenCalledWith({
      account: OWNER,
      to: OWNER,
      data: "0xba7c",
      value: 0n,
      stateOverride: [{ address: OWNER, code }],
    });
    // The authorization's own 25,000 gas joins the estimate, and half of it comes back.
    const limit = ((395_500n + 25_000n) * 5n) / 4n;
    expect(client.simulateBlocks).toHaveBeenCalledWith({
      blocks: [
        {
          calls: [{ account: OWNER, to: OWNER, data: "0xba7c", value: 0n, gas: limit }],
          stateOverrides: [{ address: OWNER, code }],
        },
      ],
    });
    expect(gas).toEqual({ short: null, fee: (316_400n + 12_500n) * gwei(0.07) });
    // The coin its calls send leaves the wallet too, though the one call to itself carries none.
    chain.client = ethereum(limit * gwei(0.13) + 999n);
    expect((await ownGas(1, OWNER, list))?.short).toContain("beyond the 0.000000000000001 ETH");
    // What it is short counts that coin too: a card that buys the coin sizes its purchase by it.
    expect((await ownGas(1, OWNER, list))?.lacks).toBe(1n);
    chain.client = ethereum(0n);
    expect((await ownGas(1, OWNER, list))?.lacks).toBe(limit * gwei(0.13) + 1000n);
    chain.client = ethereum(limit * gwei(0.13) + 1000n);
    expect((await ownGas(1, OWNER, list))?.short).toBeNull();
  });

  it("takes the whole limit as the charge where the chain can't simulate the send", async () => {
    chain.client = {
      ...ethereum(held),
      simulateBlocks: async () => Promise.reject(new Error("Method not found")),
    };
    const gas = await ownGas(1, OWNER, [{ to: ROUTER, data: "0x01" }]);
    expect(gas).toEqual({ short: null, fee: 494_375n * gwei(0.07) });
  });

  it("says nothing when the wallet can't say how it sends, or the chain what that costs", async () => {
    chain.client = ethereum(held);
    expect(await ownGas(1, OWNER, list)).toBeNull();
    chain.client = { ...ethereum(held), estimateGas: () => Promise.reject(new Error("reverted")) };
    expect(await ownGas(1, OWNER, [{ to: ROUTER, data: "0x01" }])).toBeNull();
    chain.client = null;
    expect(await ownGas(1, OWNER, [{ to: ROUTER, data: "0x01" }])).toBeNull();
  });
});

describe("assertOwnGas", () => {
  // A card shows core's own words for a failure only when they read as a sentence (the web's
  // readableError in move-rows.ts).
  const READABLE = /^[A-Z][^{}[\]]{0,200}\.$/u;

  it("stops a send the wallet can't pay for, naming the fee coin and how much of it", async () => {
    chain.client = monad(MON / 100n);
    const refusal = await assertOwnGas(143, OWNER, [{ to: ROUTER, data: "0x01" }]).catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(Refused);
    expect((refusal as Refused).kind).toBe("funds");
    expect((refusal as Refused).message).toBe(
      "Nothing was sent: too little MON for the network fee. The wallet holds 0.01 MON on " +
        "Monad, and this needs about 0.01833 MON on hand.",
    );
    expect((refusal as Refused).message).toMatch(READABLE);
  });

  it("counts the coin the send itself carries", async () => {
    chain.client = ethereum(10n ** 14n);
    const sale = [{ to: ROUTER, data: "0x01", value: (28n * 10n ** 13n).toString() }];
    const refusal = await assertOwnGas(1, OWNER, sale).catch((error: unknown) => error);
    expect((refusal as Refused).message).toBe(
      "Nothing was sent: too little ETH for the network fee. The wallet holds 0.0001 ETH on " +
        "Ethereum, and this needs about 0.00006427 ETH on hand beyond the 0.00028 ETH it sends.",
    );
    expect((refusal as Refused).message).toMatch(READABLE);
  });

  it("lets a send go that the wallet can pay for, or that nothing can cost", async () => {
    chain.client = monad(69n * MON);
    await expect(assertOwnGas(143, OWNER, [{ to: ROUTER, data: "0x01" }])).resolves.toBeUndefined();
    chain.client = null;
    await expect(assertOwnGas(143, OWNER, [{ to: ROUTER, data: "0x01" }])).resolves.toBeUndefined();
  });
});
