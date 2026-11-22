import { NETWORKS } from "@auni/shared";
import { decodeFunctionData, parseAbi, type Hex, type PublicClient } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publicClient } from "../../money/chains.ts";
import type { Signer } from "../../money/recipe.ts";
import { quoteLifiIntents } from "./lifi-intents.ts";
import { fetchJson } from "../../money/swaps/shared.ts";

// Waiting on the maker takes no time here.
vi.mock(import("node:timers/promises"), async (original) => ({
  ...(await original()),
  setTimeout: vi.fn().mockResolvedValue(undefined),
}));
vi.mock(import("../../money/chains.ts"), async (original) => ({
  ...(await original()),
  publicClient: vi.fn(),
}));
vi.mock(import("../../money/swaps/shared.ts"), async (original) => ({
  ...(await original()),
  fetchJson: vi.fn(),
}));

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SELLS = 25_000_000n;
const QUOTED = 10n ** 17n;
/** The least the trade lets land: what was quoted, less its 1% slippage. */
const LEAST = (QUOTED * 99n) / 100n;
const OPEN_ABI = parseAbi([
  "struct MandateOutput { bytes32 oracle; bytes32 settler; uint256 chainId; bytes32 token; uint256 amount; bytes32 recipient; bytes callbackData; bytes context; }",
  "struct StandardOrder { address user; uint256 nonce; uint256 originChainId; uint32 expires; uint32 fillDeadline; address inputOracle; uint256[2][] inputs; MandateOutput[] outputs; }",
  "function open(StandardOrder order)",
]);
const OPENED_IN = 100n;

/**
 * Monad as the order sees it: each status read is the next of `statuses`,
 * `late` ones past the order's expiry. The wallet holds `held` of what it sells.
 */
function monad(statuses: readonly { status: number; late?: true }[], held: bigint | Error = SELLS) {
  let read = -1;
  const now = () => statuses[Math.min(read, statuses.length - 1)]!;
  vi.mocked(publicClient).mockReturnValue({
    waitForTransactionReceipt: async () => ({ status: "success", blockNumber: OPENED_IN }),
    getBlock: async () => {
      read += 1;
      const seconds = Math.floor(Date.now() / 1_000) + (now().late ? 61 : 0);
      return { number: OPENED_IN + BigInt(read), timestamp: BigInt(seconds) };
    },
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "orderIdentifier"
        ? "0x01"
        : functionName === "balanceOf"
          ? held instanceof Error
            ? Promise.reject(held)
            : held
          : now().status,
  } as unknown as PublicClient);
}

function wallet(refund: () => Promise<string> = async () => "0xrefund") {
  return {
    evmAddress: OWNER,
    sendEvmTransaction: vi.fn(async (_chain: number, tx: unknown) =>
      Array.isArray(tx) ? "0xopen" : refund(),
    ),
  } as unknown as Signer & { sendEvmTransaction: ReturnType<typeof vi.fn> };
}

async function send(wallets: Signer, slippageBps = 100) {
  const route = await quoteLifiIntents({
    chain: "monad",
    sellToken: NETWORKS.monad.usdc,
    buyToken: "0x0000000000000000000000000000000000000a11",
    sellAmount: SELLS,
    slippageBps,
    taker: OWNER,
  });
  return route.send!(wallets);
}

/** What each order opened sold and asked the maker to pay, in the order they were opened. */
function opened(wallets: ReturnType<typeof wallet>): { sells: bigint; asks: bigint }[] {
  return wallets.sendEvmTransaction.mock.calls
    .map(([, tx]) => tx)
    .filter((tx): tx is { data: Hex }[] => Array.isArray(tx))
    .map((batch) => {
      const [order] = decodeFunctionData({ abi: OPEN_ABI, data: batch[1]!.data }).args;
      return { sells: order.inputs[0]![1], asks: order.outputs[0]!.amount };
    });
}

const OPEN = { chain: "monad", hash: "0xopen" };
const REFUND = { chain: "monad", hash: "0xrefund", setup: true };
/** An order the maker skipped: still open past its expiry, then refunded. */
const SKIPPED = [
  { status: 1, late: true },
  { status: 3, late: true },
] as const;
const FILLED = { status: 2 } as const;

function quote(amount: bigint) {
  return {
    quotes: [
      {
        preview: { outputs: [{ amount: amount.toString() }] },
        metadata: { exclusiveFor: "0x41dee1855293e4450cd67459047f372d4d818143" },
      },
    ],
  };
}

beforeEach(() => {
  vi.mocked(fetchJson).mockReset().mockResolvedValue(quote(QUOTED));
});

describe("a LI.FI order", () => {
  it("counts what the order paid once filled", async () => {
    monad([{ status: 1 }, { status: 2 }]);
    const sent = await send(wallet());
    expect(sent).toEqual({ txs: [OPEN], received: QUOTED, makerPaid: true, sold: SELLS });
  });

  it("is refunded once nobody filled it by the chain's clock, at its price or the least, and says nothing was traded", async () => {
    monad([{ status: 1 }, ...SKIPPED, ...SKIPPED]);
    const wallets = wallet();
    const sent = await send(wallets);
    expect(sent.received).toBe(0n);
    expect(sent.note).toBe("No one filled the order on Monad, so nothing was traded.");
    expect(sent.txs).toEqual([OPEN, REFUND, OPEN, REFUND]);
    expect(opened(wallets)).toMatchObject([{ asks: QUOTED }, { asks: LEAST }]);
  });

  // The maker skips an order its own posted price has gone stale for; on Oct 30 that was every
  // CRCL and HOOD buy while both rose after the open.
  it("offers the maker the least once its own price went unfilled", async () => {
    monad([...SKIPPED, FILLED]);
    const wallets = wallet();
    const sent = await send(wallets);
    expect(sent).toEqual({
      txs: [OPEN, REFUND, OPEN],
      received: LEAST,
      makerPaid: true,
      sold: SELLS,
    });
    expect(opened(wallets)).toEqual([
      { sells: SELLS, asks: QUOTED },
      { sells: SELLS, asks: LEAST },
    ]);
  });

  it("asks a fresh price above the least, less the trade's slippage", async () => {
    monad([...SKIPPED, FILLED]);
    vi.mocked(fetchJson)
      .mockResolvedValueOnce(quote(QUOTED))
      .mockResolvedValueOnce(quote(2n * QUOTED));
    const wallets = wallet();
    expect((await send(wallets)).received).toBe((2n * QUOTED * 99n) / 100n);
  });

  it("gives the maker no more than 1% under its fresh price, however wide the slippage", async () => {
    monad([...SKIPPED, FILLED]);
    const wallets = wallet();
    await send(wallets, 500);
    // The least there is 5% under the quote; the second order asks 1% under.
    expect(opened(wallets)).toMatchObject([{ asks: QUOTED }, { asks: (QUOTED * 99n) / 100n }]);
  });

  // An xStock can come back from the escrow a wei short.
  it("sells only what the refund gave back", async () => {
    monad([...SKIPPED, FILLED], SELLS - 1n);
    const wallets = wallet();
    const sent = await send(wallets);
    expect(opened(wallets).map(({ sells }) => sells)).toEqual([SELLS, SELLS - 1n]);
    expect(sent.sold).toBe(SELLS - 1n);
  });

  it("tries no second order when it can't read what the wallet got back", async () => {
    monad([...SKIPPED], new Error("rpc down"));
    const wallets = wallet();
    const sent = await send(wallets);
    expect(sent.received).toBe(0n);
    expect(sent.note).toContain("nothing was traded");
    expect(sent.txs).toEqual([OPEN, REFUND]);
  });

  it("tries no second order once the maker's price is under the least", async () => {
    monad([...SKIPPED]);
    vi.mocked(fetchJson)
      .mockResolvedValueOnce(quote(QUOTED))
      .mockResolvedValueOnce(quote(LEAST - 1n));
    const wallets = wallet();
    const sent = await send(wallets);
    expect(sent.received).toBe(0n);
    expect(sent.note).toContain("nothing was traded");
    expect(sent.txs).toEqual([OPEN, REFUND]);
  });

  // The wallet reports the refund landed before this RPC has its block.
  it("reads the order's status only once this RPC has the refund", async () => {
    monad([{ status: 1 }, { status: 1, late: true }]);
    // No maker quotes a second order, so this reads one order's refund alone.
    vi.mocked(fetchJson).mockResolvedValueOnce(quote(QUOTED)).mockResolvedValueOnce({ quotes: [] });
    const client = vi.mocked(publicClient)("monad");
    const lagging = client.readContract;
    let refundSeen = false;
    vi.mocked(publicClient).mockReturnValue({
      ...client,
      waitForTransactionReceipt: async ({ hash }: { hash: string }) => {
        if (hash === "0xrefund") refundSeen = true;
        return { status: "success", blockNumber: OPENED_IN };
      },
      readContract: async (args: { functionName: string }) =>
        args.functionName === "orderStatus" && refundSeen ? 3 : lagging(args as never),
    } as unknown as PublicClient);
    const sent = await send(wallet());
    expect(sent.received).toBe(0n);
    expect(sent.note).toContain("nothing was traded");
  });

  // The refund reverts when a fill lands first, and the order's last status says so.
  it("counts a fill that beat its refund", async () => {
    monad([
      { status: 1, late: true },
      { status: 2, late: true },
    ]);
    const sent = await send(wallet(() => Promise.reject(new Error("reverted"))));
    expect(sent).toEqual({ txs: [OPEN], received: QUOTED, makerPaid: true, sold: SELLS });
  });
});
