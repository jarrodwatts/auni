import {
  decodeFunctionData,
  encodeErrorResult,
  erc20Abi,
  getAddress,
  parseAbi,
  type Address,
} from "viem";
import { expect, vi } from "vitest";

import { APPROVED_PROCEEDS } from "../../money/approved.ts";
import { parseUnits } from "../../money/usd.ts";
import { holdsToCard } from "../../test/held-to-card.ts";
import { OWNER } from "../../test/wallets.ts";
import { CONTRACTS } from "./http.ts";
import { SWAP_ROUTER } from "./withdraw.ts";

// The owner's deposit wallet holds $80 of pUSD. Polymarket's offramp pays USDC.e one for one,
// and the pool pays `rateMicros` of USDC for each USDC.e, as a node would say running the batch
// first: the swap reverts, in the router's own words, when it would pay less than the batch asks.
const WALLET = "0x2222222222222222222222222222222222222222" as Address;

const world = vi.hoisted(() => ({ cash: 0n, rateMicros: 0n }));

const offramp = parseAbi(["function unwrap(address asset, address to, uint256 amount)"]);
const router = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);

/** The swap a batch ends with, decoded. */
const swapOf = (data: string) =>
  decodeFunctionData({ abi: router, data: data as `0x${string}` }).args[0];

vi.mock(import("./wallet.ts"), async (original) => ({
  ...(await original()),
  depositWallet: vi.fn(async () => ({
    address: "0x2222222222222222222222222222222222222222" as Address,
    deployed: true,
  })),
  erc20Balance: vi.fn(async () => world.cash),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => (await import("../../test/wallets.ts")).OWNER.evm,
}));
vi.mock(import("../../money/wallet-effect.ts"), async (original) => ({
  ...(await original()),
  simulateEffect: vi.fn(async (_chainId, _owner, calls) => {
    const swap = swapOf(calls.at(-1)!.data!);
    const pays = (swap.amountIn * world.rateMicros) / 1_000_000n;
    if (pays < swap.amountOutMinimum)
      throw new Error("Auni ran this first and step 4 of 4 would have failed.", {
        cause: {
          data: encodeErrorResult({
            abi: parseAbi(["error Error(string)"]),
            args: ["Too little received"],
          }),
        },
      });
    return {
      out: [],
      in: [{ token: swap.tokenOut, amount: pays }],
      grants: [],
      blind: false,
      logs: [],
    };
  }),
}));
// The relayer takes the batch and confirms it at once.
vi.mock(import("./http.ts"), async (original) => ({
  ...(await original()),
  relayerRequest: vi.fn(async (_method: string, path: string) =>
    path === "/v1/account/transactions/params"
      ? { nonce: "7" }
      : path === "/submit"
        ? { transactionID: "relay-1" }
        : { state: "STATE_CONFIRMED", transaction_hash: "0xhome" },
  ),
}));

holdsToCard("polymarket_withdraw", {
  world() {
    Object.assign(world, { cash: 80_000_000n, rateMicros: 999_962n });
  },
  asShown: {
    "$20 of the cash there": { amountUsd: 20 },
    "all of it": {},
  },
  paysAsShown(signed, card) {
    // One batch, signed for the owner's own deposit wallet, and nothing sent from their wallet.
    expect(signed.evm).toEqual([]);
    expect(signed.typed).toHaveLength(1);
    const { domain, message } = signed.typed[0]!;
    expect(domain.verifyingContract).toBe(WALLET.toLowerCase());
    expect(message.wallet).toBe(WALLET.toLowerCase());
    const calls = message.calls as { target: string; value: string; data: `0x${string}` }[];
    const units = parseUnits(card.amountUsd, 6);
    const erc20 = (data: `0x${string}`) => decodeFunctionData({ abi: erc20Abi, data });
    // Exactly the card's pUSD leaves, through Polymarket's offramp, as USDC.e the wallet keeps
    // only until the swap; each approval is of exactly what the next call takes.
    expect(calls.map(({ target, value }) => [getAddress(target), value])).toEqual([
      [CONTRACTS.pusd, "0"],
      [CONTRACTS.collateralOfframp, "0"],
      [CONTRACTS.usdce, "0"],
      [SWAP_ROUTER, "0"],
    ]);
    expect(erc20(calls[0]!.data)).toEqual({
      functionName: "approve",
      args: [CONTRACTS.collateralOfframp, units],
    });
    expect(decodeFunctionData({ abi: offramp, data: calls[1]!.data }).args).toEqual([
      CONTRACTS.usdce,
      WALLET,
      units,
    ]);
    expect(erc20(calls[2]!.data)).toEqual({ functionName: "approve", args: [SWAP_ROUTER, units] });
    // The swap pays the owner's own wallet and no other address, in native USDC, and reverts
    // unless at least what the card said arrives.
    expect(swapOf(calls[3]!.data)).toMatchObject({
      tokenIn: CONTRACTS.usdce,
      tokenOut: CONTRACTS.usdc,
      fee: 100,
      recipient: OWNER.evm,
      amountIn: units,
      amountOutMinimum: parseUnits(card.details[APPROVED_PROCEEDS]!, 6),
      sqrtPriceLimitX96: 0n,
    });
  },
  priceMoved: {
    "once the pool pays less than the least its card showed": {
      input: { amountUsd: 20 },
      after: () => {
        world.rateMicros = 990_000n;
      },
    },
  },
  takesMore: {
    never:
      "it brings exactly its card's amount, read from the card and never from the wallet, which paysAsShown reads; withdraw.test.ts holds that cash arriving after the card stays where it is",
  },
  paysElsewhere: {
    never:
      "no input names a destination: the swap pays the owner's own wallet, which paysAsShown reads",
  },
});
