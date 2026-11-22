import { NETWORKS } from "@auni/shared";
import { decodeFunctionData, erc20Abi, parseAbi, type Address, type PublicClient } from "viem";
import { describe, expect, it, vi } from "vitest";

import { publicClient } from "../../money/chains.ts";
import type { EvmTx, Signer } from "../../money/recipe.ts";
import { receivedBy } from "../../money/swaps/evm.ts";
import { kuruQuote } from "./kuru.ts";

vi.mock(import("../../money/chains.ts"), async (original) => ({
  ...(await original()),
  publicClient: vi.fn(),
}));
vi.mock(import("../../money/swaps/evm.ts"), async (original) => ({
  ...(await original()),
  confirm: vi.fn(async () => ({ blockNumber: TRADED_IN }) as never),
  receivedBy: vi.fn(),
}));

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const NVDAX = "0xc845b2894dBddd03858fd2D643B4eF725fE0849d";
const SPYX = "0x90A2a4c76b5D8c0bc892A69EA28Aa775a8f2dD48";
const SPYX_BOOK = "0xBb180c8B6D3eE0b4316B224C53B80dC4e354d24F";
const USDC = NETWORKS.monad.usdc;
const TRADED_IN = 100n;
const STEP = 100n;
// $200 quoted for the shares; the fill beat its 1% minimum by $1.50.
const QUOTED = 200_000_000n;
const SURPLUS = 1_500_000n;
const DUST = 23n;

const abi = [
  ...erc20Abi,
  ...parseAbi([
    "function deposit(address rootOwner, address token, uint256 amount)",
    "function withdraw(uint40 rootAccountId, address token, uint256 amount, address recipient)",
    "function swap(uint40 userId, bool isBuy, uint128 amountIn, uint128 minAmountOut, uint64 deadline)",
  ]),
];
/** What the owner's Kuru account held before the trade, and a contract whose reads fail. */
interface Kuru {
  readonly earlier?: Partial<Record<Address, bigint>>;
  readonly unreadable?: Address;
}

const calls = (txs: readonly EvmTx[]) =>
  txs.map((tx) => {
    const { functionName, args = [] } = decodeFunctionData({ abi, data: tx.data as `0x${string}` });
    // A swap's deadline is the clock's.
    return [functionName, ...(functionName === "swap" ? args.slice(0, 4) : args)];
  });

/**
 * Kuru as a sale of `sold` NVDAx sees it, for a user whose Kuru account is 7
 * and held, before the trade, dust of every stock plus what `earlier` says.
 */
function kuru(sold: bigint, { earlier = {}, unreadable }: Kuru) {
  vi.mocked(publicClient).mockReturnValue({
    readContract: async ({
      address,
      functionName,
      args,
      blockNumber,
    }: {
      address: Address;
      functionName: string;
      args: readonly unknown[];
      blockNumber?: bigint;
    }) => {
      if (address === unreadable) throw new Error("execution reverted");
      switch (functionName) {
        case "baseSizeMultiplier":
          return STEP;
        case "estimateSwap":
          return [args[1], QUOTED];
        case "previewWithdrawal":
          return [0n, 0n, true];
        case "rootAccountIdOf":
          return 7;
        case "getBalance": {
          const token = args[1] as Address;
          const had = earlier[token] ?? (token === USDC ? 0n : DUST);
          if (blockNumber !== TRADED_IN) return had;
          return had + (token === USDC ? SURPLUS : token === NVDAX ? sold % STEP : 0n);
        }
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  } as unknown as PublicClient);
}

async function sell(sweep: () => Promise<string>, account: Kuru = {}) {
  const sold = 10n ** 18n + DUST;
  kuru(sold, account);
  const sendEvmTransaction = vi.fn(async (_chain: number, txs: readonly EvmTx[]) =>
    txs.some((tx) => tx.setup) ? sweep() : "0xtrade",
  );
  const wallets = { evmAddress: OWNER, sendEvmTransaction } as unknown as Signer;
  const route = await kuruQuote({
    chain: "monad",
    sellToken: NVDAX,
    buyToken: USDC,
    sellAmount: sold,
    slippageBps: 100,
    taker: OWNER,
  });
  // What reached the wallet in the trade itself: the owner's minimum.
  vi.mocked(receivedBy).mockResolvedValue(route.minBuyAmount);
  const sent = await route.send!(wallets);
  return { route, sent, sold, batches: sendEvmTransaction.mock.calls.map(([, txs]) => txs) };
}

describe("a sale on Kuru", () => {
  it("pays the owner's minimum in the trade, then sweeps the surplus home", async () => {
    const { route, sent, sold, batches } = await sell(async () => "0xsweep");
    expect(route.buyAmount).toBe(QUOTED);
    expect(calls(batches[0]!)).toEqual([
      ["approve", "0x264123a9B96Cc1193944cC25C188f1bD3dFa670e", sold],
      ["deposit", OWNER, NVDAX, sold],
      // Whole size steps of what Kuru may credit: a wei less than was sent.
      ["swap", 7, false, 10n ** 18n, 198_000_000n],
      ["withdraw", 7, USDC, 198_000_000n, OWNER],
    ]);
    // The size-step dust stays; the surplus comes home as a step that isn't the trade.
    expect(calls(batches[1]!)).toEqual([["withdraw", 7, USDC, SURPLUS, OWNER]]);
    expect(sent).toEqual({
      txs: [
        { chain: "monad", hash: "0xtrade" },
        { chain: "monad", hash: "0xsweep", setup: true },
      ],
      received: 198_000_000n + SURPLUS,
    });
  });

  it("brings home what an earlier sweep left, in any stock, without counting it again", async () => {
    const earlier = { [USDC]: 2_000_000n, [SPYX]: 3n * STEP };
    const { sent, batches } = await sell(async () => "0xsweep", { earlier });
    // Every other stock's dust stays, as this one's does.
    expect(calls(batches[1]!)).toEqual([
      ["withdraw", 7, USDC, 2_000_000n + SURPLUS, OWNER],
      ["withdraw", 7, SPYX, 3n * STEP, OWNER],
    ]);
    // The earlier USDC is not what this trade bought.
    expect(sent.received).toBe(198_000_000n + SURPLUS);
  });

  it("still records the trade when it can't read what to sweep", async () => {
    const { sent, batches } = await sell(async () => "0xsweep", { unreadable: SPYX_BOOK });
    expect(batches).toHaveLength(1);
    expect(sent).toEqual({
      txs: [{ chain: "monad", hash: "0xtrade" }],
      received: 198_000_000n + SURPLUS,
      note: expect.stringContaining("still in the owner's Kuru account"),
    });
  });

  it("still counts the surplus when the sweep fails, and says where it is", async () => {
    const { sent } = await sell(() => Promise.reject(new Error("reverted")));
    expect(sent.received).toBe(198_000_000n + SURPLUS);
    expect(sent.txs).toEqual([{ chain: "monad", hash: "0xtrade" }]);
    expect(sent.note).toContain("still in the owner's Kuru account");
  });
});
