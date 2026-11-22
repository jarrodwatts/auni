import { NETWORKS } from "@auni/shared";
import { decodeFunctionData, getAddress, maxUint256, parseAbi } from "viem";
import { expect, vi } from "vitest";

import { publicClient } from "../../money/chains.ts";
import { parseUnits } from "../../money/usd.ts";
import { erc20Calls, holdsToCard } from "../../test/held-to-card.ts";
import { OWNER, type Signed } from "../../test/wallets.ts";
import { AAVE } from "./aave.ts";

// The owner holds $200 in Aave savings on Base, whose pool may spend none of their USDC yet.
const pool = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to)",
]);
const savings = vi.hoisted(() => ({ units: 0n }));

function world() {
  savings.units = 200_000_000n;
  vi.spyOn(publicClient("base"), "readContract").mockImplementation((async ({
    functionName,
  }: {
    functionName: string;
  }) =>
    functionName === "allowance"
      ? 0n
      : functionName === "balanceOf"
        ? savings.units
        : { currentLiquidityRate: 418n * 10n ** 23n }) as never);
}

/** The pool calls sent, decoded. */
const poolCalls = (signed: Signed) =>
  signed.evm.flatMap(({ txs }) =>
    txs.flatMap((tx) =>
      getAddress(tx.to) === getAddress(AAVE.base.pool)
        ? [decodeFunctionData({ abi: pool, data: tx.data as `0x${string}` })]
        : [],
    ),
  );

holdsToCard("aave_supply", {
  world,
  asShown: { "$50 into savings on Base": { chain: "base", amount_usd: "50" } },
  paysAsShown(signed, card) {
    const units = parseUnits(card.amountUsd, 6);
    // The pool may take exactly this supply's USDC, and credits the owner's own wallet.
    expect(erc20Calls(signed)).toEqual([
      {
        chainId: NETWORKS.base.viem.id,
        token: getAddress(NETWORKS.base.usdc),
        call: "approve",
        to: getAddress(AAVE.base.pool),
        units,
      },
    ]);
    expect(poolCalls(signed)).toEqual([
      { functionName: "supply", args: [getAddress(NETWORKS.base.usdc), units, OWNER.evm, 0] },
    ]);
  },
  priceMoved: { never: "savings take USDC dollar for dollar" },
  takesMore: { never: "it supplies its card's amount, which no quote sizes" },
  paysElsewhere: { never: "the pool credits the owner's own wallet, which paysAsShown reads" },
});

holdsToCard("aave_withdraw", {
  world,
  asShown: {
    "$50 of savings on Base": { chain: "base", amount_usd: "50" },
    "all of it, asking for what the card showed": { chain: "base", amount_usd: "200" },
  },
  paysAsShown(signed, card) {
    // Back to the owner's own wallet, no more than the card showed; all of it once it asked for all.
    const asked = parseUnits(card.amountUsd, 6);
    expect(poolCalls(signed)).toEqual([
      {
        functionName: "withdraw",
        args: [
          getAddress(NETWORKS.base.usdc),
          asked >= savings.units ? maxUint256 : asked,
          OWNER.evm,
        ],
      },
    ]);
    expect(erc20Calls(signed)).toEqual([]);
  },
  priceMoved: { never: "savings pay back USDC dollar for dollar" },
  takesMore: {
    never: "it withdraws its card's amount, or the whole balance when that is less, never more",
  },
  paysElsewhere: { never: "the pool pays the owner's own wallet, which paysAsShown reads" },
});
