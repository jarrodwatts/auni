import { NETWORKS } from "@auni/shared";
import {
  createTestClient,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  pad,
  parseEther,
  parseGwei,
  publicActions,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { DELEGATOR, sendEvmTransaction } from "./evm.ts";
import { signedTxs } from "./tables.ts";
import { actions } from "../../db/schema.ts";
import { insertAction, wipe } from "../../test/db.ts";
import { evmClient, publicClient, publicRpcClient } from "../../money/chains.ts";
import { feeCoinDetails } from "../../money/fee-coin-said.ts";
import { payingFees, topUpFor } from "../../money/fee-coin.ts";
import type { EvmTx, KeptTx, Signer } from "../../money/recipe.ts";

// What a fork shows of the swap a card makes for Monad's fees (money/fee-coin.ts): a wallet the
// move would leave low on MON first swaps exactly the card's USDC for MON, through KyberSwap's
// real route on Monad's real pools, in a send of its own that delegates the account, then sends
// the move; and a card that swapped never swaps again. The wallet starts as the new owner's of
// 2026-11-14 stood after two stock buys: 0.7396 MON, and USDC.
//
//   anvil --fork-url https://rpc2.monad.xyz --port 8547
//   AUNI_FORK_RPC=http://127.0.0.1:8547 pnpm --filter @auni/core test:db fee-coin-swap.fork
//
// KyberSwap is asked for its route as the test runs, as a card would ask it. It builds the route
// on Monad as it stands, so start the fork just before: one a few minutes old no longer matches
// Monad's pools, and the route fails there, so the card swaps nothing.
const FORK = process.env.AUNI_FORK_RPC;

vi.mock(import("../../money/chains.ts"), async (original) => ({
  ...(await original()),
  evmClient: vi.fn(),
  publicClient: vi.fn(),
  publicRpcClient: vi.fn(),
}));
const account = privateKeyToAccount(keccak256(toHex("auni runway fork test")));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => account.address,
  paysOwnGas: async () => true,
  // The local key's own, asked as it sends (that file loads this one).
  asSent: async (chainId, owner, txs) => (await import("./evm.ts")).asSent(chainId, owner, txs),
}));
// MON at its price that day.
vi.mock(import("../../money/token-feeds.ts"), async (original) => ({
  ...(await original()),
  feedListing: (async (chain: string) =>
    chain === "monad" ? { usdPrice: 0.01685 } : null) as never,
}));

const MONAD = NETWORKS.monad.viem;
const USDC = NETWORKS.monad.usdc as Address;
const SOMEONE = privateKeyToAccount(keccak256(toHex("someone else"))).address;

describe.skipIf(!FORK)("a card's swap for Monad's fees, on a fork", { timeout: 180_000 }, () => {
  const fork = createTestClient({
    chain: MONAD,
    mode: "anvil",
    transport: http(FORK),
    pollingInterval: 100,
  }).extend(publicActions);
  const usdc = (address: Address) =>
    fork.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] });
  /** Circle's USDC keeps balances at slot 9. */
  const holdUsdc = (address: Address, units: bigint) =>
    fork.setStorageAt({
      address: USDC,
      index: keccak256(`${pad(address)}${pad(toHex(9)).slice(2)}` as Hex),
      value: pad(toHex(units)),
    });
  let actionId = "";
  const kept: KeptTx[] = [];
  // Each test starts from Monad's own fees: anvil lowers its base fee block by block once its
  // blocks are empty, where Monad's stayed at 100 gwei (its fee history, November 2026).
  let start: Hex | null = null;
  beforeAll(async () => {
    const monads = parseGwei("100");
    for (let block = 0; block <= 10; block++) {
      await fork.setNextBlockBaseFeePerGas({ baseFeePerGas: monads });
      await fork.mine({ blocks: 1 });
    }
    await fork.setNextBlockBaseFeePerGas({ baseFeePerGas: monads });
  });

  beforeEach(async () => {
    if (start) await fork.revert({ id: start });
    start = await fork.snapshot();
    vi.mocked(evmClient).mockReturnValue(fork as never);
    vi.mocked(publicClient).mockReturnValue(fork as never);
    vi.mocked(publicRpcClient).mockReturnValue(null);
    await wipe(actions, signedTxs);
    actionId = (await insertAction()).id;
    kept.length = 0;
    await fork.setBalance({ address: account.address, value: 739_554_019_000_000_000n });
    await fork.setCode({ address: account.address, bytecode: "0x" });
    await holdUsdc(account.address, 3_000_000n);
    await holdUsdc(SOMEONE, 0n);
  });

  /** The local key's wallet for this action, keeping each send as the action would. */
  const signer = async (keep: (tx: KeptTx) => Promise<void>): Promise<Signer> => ({
    evmAddress: account.address,
    solanaAddress: "",
    sendEvmTransaction: (chainId, tx) =>
      sendEvmTransaction(account, chainId, "to" in tx ? [tx] : tx, {
        actionId,
        attempt: 1,
        onSent: keep,
      }),
    signEvmTypedData: () => Promise.reject(new Error("not in this test")),
    sendSolanaTransaction: () => Promise.reject(new Error("not in this test")),
  });
  const keep = async (tx: KeptTx) => void kept.push(tx);
  /** The move: a dollar of USDC to someone, as one call. */
  const move: EvmTx[] = [
    {
      to: USDC,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [SOMEONE, 1_000_000n],
      }),
    },
  ];

  it("swaps exactly the card's USDC for MON in a send of its own before the move, and never twice", async () => {
    const bought = await topUpFor(MONAD.id, 1);
    expect(bought).toMatchObject({
      chain: "monad",
      from: "monad",
      token: USDC,
      amount: 250_000n,
      usd: 0.25,
      by: "KyberSwap",
    });
    const details = feeCoinDetails(bought!);
    const monBefore = await fork.getBalance({ address: account.address });

    const wallets = await payingFees({ details, txs: [] }, signer, keep, {
      chain: "monad",
      usdc: 1_000_000n,
    });
    await wallets.sendEvmTransaction(MONAD.id, move);

    // Exactly the card's quarter and the move's dollar left; the dollar reached its address.
    expect(await usdc(account.address)).toBe(3_000_000n - 250_000n - 1_000_000n);
    expect(await usdc(SOMEONE)).toBe(1_000_000n);
    // The MON came, about 14.8 of it, more than both sends charged.
    const monAfter = await fork.getBalance({ address: account.address });
    expect(monAfter - monBefore).toBeGreaterThan(parseEther("10"));

    // Two sends: the swap, kept as the card's purchase, which delegated the account; then the move.
    const [swap, sent, ...more] = kept;
    expect(more).toEqual([]);
    expect(swap).toMatchObject({ chain: "monad", setup: true, buysFees: "swap" });
    expect(sent?.buysFees).toBeUndefined();
    const first = await fork.getTransaction({ hash: swap!.hash as Hex });
    expect(first.type).toBe("eip7702");
    expect(await fork.getCode({ address: account.address })).toBe(
      `0xef0100${DELEGATOR.slice(2).toLowerCase()}`,
    );
    // The swap's batch approved exactly the card's quarter, and nothing else of the wallet's.
    const receipt = await fork.getTransactionReceipt({ hash: swap!.hash as Hex });
    const approvals = receipt.logs.filter(
      (log) =>
        log.address.toLowerCase() === USDC.toLowerCase() &&
        log.topics[0] === keccak256(toHex("Approval(address,address,uint256)")),
    );
    expect(approvals.map((log) => BigInt(log.data))).toEqual([250_000n]);
    const moved = await fork.getTransaction({ hash: sent!.hash as Hex });
    expect(moved.type).toBe("eip1559");

    // Try again on the same card, after its run kept the swap: the move goes, and no swap.
    const again = await payingFees({ details, txs: [...kept] }, signer, keep, {
      chain: "monad",
      usdc: 1_000_000n,
    });
    await again.sendEvmTransaction(MONAD.id, move);
    expect(kept).toHaveLength(3);
    expect(kept[2]?.buysFees).toBeUndefined();
    expect(await usdc(account.address)).toBe(750_000n);
    expect(
      decodeFunctionData({
        abi: erc20Abi,
        data: (await fork.getTransaction({ hash: kept[2]!.hash as Hex })).input,
      }).functionName,
    ).toBe("transfer");
  });

  it("swaps nothing where the wallet keeps enough MON for the moves after it", async () => {
    await fork.setBalance({ address: account.address, value: parseEther("10") });
    expect(await topUpFor(MONAD.id, 1)).toBeNull();
  });

  it("leaves the USDC the move spends: with too little beside it, the move goes alone", async () => {
    const details = feeCoinDetails((await topUpFor(MONAD.id, 1))!);
    await holdUsdc(account.address, 1_100_000n);
    const wallets = await payingFees({ details, txs: [] }, signer, keep, {
      chain: "monad",
      usdc: 1_000_000n,
    });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    await wallets.sendEvmTransaction(MONAD.id, move);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.buysFees).toBeUndefined();
    expect(await usdc(account.address)).toBe(100_000n);
    expect(String(warned.mock.calls[0]?.[1])).toContain(
      "The $0.25 of USDC its card showed swapping for MON isn't there beside what the move spends",
    );
    warned.mockRestore();
  });
});
