import { NETWORKS } from "@auni/shared";
import {
  encodeAbiParameters,
  erc20Abi,
  decodeFunctionData,
  pad,
  RpcRequestError,
  toEventSelector,
  TransactionReceiptNotFoundError,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EvmTx, Signer } from "../recipe.ts";
import { simulateEffect, type SimulatedEffect } from "../wallet-effect.ts";
import { EVM_NATIVE } from "../fill-key.ts";
import {
  coinMovedBy,
  confirmedReceipts,
  receivedBy,
  sendEvmSwap,
  type EvmQuoteRequest,
  type EvmRoute,
} from "./evm.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const ROUTER = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = NETWORKS.base.usdc;

// The chain answers with the wallet's allowance, and a receipt paying it 0.01 WETH.
const allowance = vi.hoisted(() => ({ units: 0n }));
// What the chain answers of a sent transaction: its receipts, its call trace, and the
// wallet's coin at each block.
const read = vi.hoisted(() => ({
  receipts: new Map<string, object | null>(),
  trace: null as object | null,
  balances: new Map<bigint, bigint>(),
}));
vi.mock("../chains.ts", async (original) => ({
  ...(await original()),
  evmClient: () => ({
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      const found = read.receipts.get(hash);
      if (found === undefined) throw new Error("HTTP request failed. Status: 500");
      if (found === null) throw new TransactionReceiptNotFoundError({ hash: hash as Hex });
      return found;
    },
    request: async () => {
      if (read.trace) return read.trace;
      throw new RpcRequestError({
        body: {},
        error: { code: -32601, message: "the method debug_traceTransaction does not exist" },
        url: "https://rpc.invalid",
      });
    },
  }),
  publicClient: () => ({
    getBalance: async ({ blockNumber }: { blockNumber: bigint }) =>
      read.balances.get(blockNumber) ?? 0n,
    readContract: async () => allowance.units,
    waitForTransactionReceipt: async () => ({
      status: "success",
      logs: [
        {
          address: WETH,
          topics: [toEventSelector("Transfer(address,address,uint256)"), pad(ROUTER), pad(OWNER)],
          data: encodeAbiParameters([{ type: "uint256" }], [10n ** 16n]),
        },
      ],
    }),
  }),
}));
vi.mock("../wallet-effect.ts", async (original) => ({
  ...(await original()),
  simulateEffect: vi.fn(),
}));

const request: EvmQuoteRequest = {
  chain: "base",
  sellToken: USDC,
  buyToken: WETH,
  sellAmount: 40_000_000n,
  slippageBps: 100,
  taker: OWNER,
};
const route: EvmRoute = {
  provider: "KyberSwap",
  buyAmount: 10n ** 16n,
  minBuyAmount: 99n * 10n ** 14n,
  spender: ROUTER,
  transaction: { to: ROUTER, data: "0x1234", value: 0n },
};
const seen = (effect: Partial<SimulatedEffect>): SimulatedEffect => ({
  out: [{ token: USDC, amount: 40_000_000n }],
  in: [{ token: WETH, amount: 10n ** 16n }],
  grants: [],
  blind: false,
  sentTo: [ROUTER],
  logs: [],
  ...effect,
});

let sent: (EvmTx | readonly EvmTx[])[] = [];
const wallets = {
  evmAddress: OWNER,
  sendEvmTransaction: async (_chainId: number, tx: EvmTx | readonly EvmTx[]) => {
    sent.push(tx);
    return "0xswap";
  },
} as unknown as Signer;

beforeEach(() => {
  sent = [];
  allowance.units = 0n;
  read.receipts.clear();
  read.trace = null;
  read.balances.clear();
});

// KyberSwap builds the swap's bytes; they go only once a simulation shows them doing what was asked.
describe("sendEvmSwap", () => {
  it("approves exactly what the swap spends in the same batch, so no approval outlives a failed swap", async () => {
    vi.mocked(simulateEffect).mockResolvedValue(seen({}));
    const result = await sendEvmSwap(wallets, request, route);
    expect(sent).toHaveLength(1);
    const [batch] = sent as EvmTx[][];
    expect(batch).toHaveLength(2);
    expect(decodeFunctionData({ abi: erc20Abi, data: batch![0]!.data as `0x${string}` })).toEqual({
      functionName: "approve",
      args: [ROUTER, 40_000_000n],
    });
    expect(batch![1]).toEqual({ to: ROUTER, data: "0x1234", value: "0" });
    // What was simulated is exactly what was sent.
    expect(simulateEffect).toHaveBeenCalledWith(8453, OWNER, batch);
    expect(result).toEqual({ txs: [{ chain: "base", hash: "0xswap" }], received: 10n ** 16n });
  });

  it("asks for no approval the wallet has already given", async () => {
    allowance.units = 40_000_000n;
    vi.mocked(simulateEffect).mockResolvedValue(seen({}));
    await sendEvmSwap(wallets, request, route);
    expect(sent).toEqual([[{ to: ROUTER, data: "0x1234", value: "0" }]]);
  });

  it("sends nothing whose simulation pays what it buys to someone else", async () => {
    vi.mocked(simulateEffect).mockResolvedValue(seen({ in: [] }));
    await expect(sendEvmSwap(wallets, request, route)).rejects.toThrow(
      "It would get less into your wallet than was shown",
    );
    expect(sent).toEqual([]);
  });

  it("sends nothing whose simulation takes more than the sale, or leaves an approval behind", async () => {
    vi.mocked(simulateEffect).mockResolvedValue(
      seen({ out: [{ token: USDC, amount: 40_000_001n }] }),
    );
    await expect(sendEvmSwap(wallets, request, route)).rejects.toThrow("would send more");
    vi.mocked(simulateEffect).mockResolvedValue(
      seen({ grants: [{ kind: "spend", token: USDC, to: ROUTER }] }),
    );
    await expect(sendEvmSwap(wallets, request, route)).rejects.toThrow("permission");
    expect(sent).toEqual([]);
  });

  it("sends nothing it couldn't simulate", async () => {
    vi.mocked(simulateEffect).mockResolvedValue(null);
    await expect(sendEvmSwap(wallets, request, route)).rejects.toThrow("couldn't check");
    expect(sent).toEqual([]);
  });
});

// What a move's sends did, read after its run stopped (see Recipe.readBack), or as it ran.
describe("what a transaction paid the wallet", () => {
  const STRANGER = "0x7777777777777777777777777777777777777777";
  const sold = {
    status: "success",
    from: OWNER,
    to: ROUTER,
    transactionHash: "0xsold",
    blockNumber: 10n,
    gasUsed: 21_000n,
    effectiveGasPrice: 2n,
    logs: [],
  } as unknown as TransactionReceipt;

  it("reads the coin a transaction paid from its call trace, whatever else the block did", async () => {
    read.trace = {
      type: "CALL",
      from: OWNER,
      to: ROUTER,
      value: "0x0",
      calls: [
        // The router pays 100 wei, two calls deep.
        {
          type: "CALL",
          from: ROUTER,
          to: WETH,
          calls: [{ type: "CALL", from: WETH, to: OWNER, value: "0x64" }],
        },
        // A payment that reverted paid nothing.
        { type: "CALL", from: ROUTER, to: OWNER, value: "0x32", error: "execution reverted" },
      ],
    };
    // A stranger's 40 wei in the same block shows only in the balance, never in the trace.
    read.balances.set(9n, 1_000n).set(10n, 1_140n);
    expect(await receivedBy("base", sold, EVM_NATIVE, OWNER)).toBe(100n);
    expect(await coinMovedBy("base", [sold, sold], OWNER)).toEqual({ in: 200n, out: 0n });
  });

  it("falls back to the balance across the block, its own fee put back, where no trace is served", async () => {
    read.balances.set(9n, 1_000n).set(10n, 1_100n - 42_000n);
    expect(await receivedBy("base", sold, EVM_NATIVE, OWNER)).toBe(100n);
    // Paid by someone else's transaction, nothing of the fee is the owner's.
    const theirs = { ...sold, from: STRANGER } as TransactionReceipt;
    read.balances.set(10n, 1_100n);
    expect(await receivedBy("base", theirs, EVM_NATIVE, OWNER)).toBe(100n);
    // A read back never guesses: with no trace it can't tell.
    expect(await coinMovedBy("base", [sold], OWNER)).toBeNull();
  });

  it("reads back only the move's own sends on the chain that confirmed, each once", async () => {
    read.receipts
      .set("0xok", { status: "success", logs: [] })
      .set("0xreverted", { status: "reverted", logs: [] })
      .set("0xreplaced", null)
      .set("0xfees", { status: "success", logs: [{ swapped: "USDC for ETH" }] });
    const kept = [
      { chain: "base", hash: "0xok" },
      { chain: "base", hash: "0xok", walletTxId: "w1" },
      { chain: "base", hash: "0xreverted" },
      { chain: "base", hash: "0xreplaced" },
      { chain: "base" },
      { chain: "monad", hash: "0xelsewhere" },
      // What its card swapped for the chain's fee coin is no part of what the move traded.
      { chain: "base", hash: "0xfees", setup: true as const, buysFees: "swap" },
    ];
    expect(await confirmedReceipts("base", kept)).toEqual([{ status: "success", logs: [] }]);
    // Any other failure to read throws, so nothing is read back from half of what was sent.
    await expect(confirmedReceipts("base", [{ chain: "base", hash: "0xdown" }])).rejects.toThrow(
      "500",
    );
  });
});
