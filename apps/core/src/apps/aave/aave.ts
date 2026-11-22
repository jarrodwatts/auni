import { EVM_CASH_KEYS, NETWORKS, type EvmCashKey } from "@auni/shared";
import {
  encodeFunctionData,
  erc20Abi,
  isAddressEqual,
  maxUint256,
  parseAbi,
  type Address,
} from "viem";
import { z } from "zod";

import { exactApproval } from "../../money/approval.ts";
import { publicClient } from "../../money/chains.ts";
import { evmTokenKey } from "../../money/fill-key.ts";
import type { EvmTx, Fill, Recipe } from "../../money/recipe.ts";
import { confirmedReceipts, receivedBy } from "../../money/swaps/evm.ts";
import { dollars } from "../../money/summaries.ts";
import { walletEffect } from "../../money/wallet-effect.ts";
import { formatUnits, normalizeUsd, parseUnits } from "../../money/usd.ts";
import { supplyFace, withdrawFace } from "./card.ts";
import { refusal } from "./problems.ts";

/**
 * Aave V3 on every EVM chain where Auni spends USDC as Cash, each read from its Pool's reserve data
 * for native USDC. Savings are held as the aToken, which the portfolio reads.
 */
export const AAVE = {
  monad: {
    pool: "0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef",
    aUsdc: "0x35a73BAcb179d3740395A3ceCc87FF2e581d6042",
  },
  base: {
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    aUsdc: "0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB",
  },
  arbitrum: {
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    aUsdc: "0x724dc807b04555b71ed48a6896b6F41593b8C637",
  },
  polygon: {
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    aUsdc: "0xA4D94019934D8333Ef880ABFFbF2FDd611C762BD",
  },
} as const satisfies Record<EvmCashKey, { pool: Address; aUsdc: Address }>;

/** The Aave market on `chain`, where Auni has one. */
export function aaveMarket(chain: string): { pool: Address; aUsdc: Address } | null {
  return Object.hasOwn(AAVE, chain) ? AAVE[chain as EvmCashKey] : null;
}

const poolAbi = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);

const savingsInput = {
  chain: z
    .enum(EVM_CASH_KEYS)
    .describe("The chain whose Aave market holds the savings: where the USDC already sits."),
  amount_usd: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/u)
    .describe('USDC amount as a decimal string, e.g. "250" or "12.5".'),
};

export const aaveSupply: Recipe<typeof savingsInput> = {
  tool: "aave_supply",
  venue: "aave",
  description:
    "Supply USDC from the owner's wallet into Aave V3 savings on the same chain (Monad, Base, " +
    "Arbitrum or Polygon), where it earns that market's variable supply rate, shown on the card. " +
    "The wallet must already hold the USDC on that chain (bridge it first if not).",
  input: savingsInput,
  fundedFrom: ({ input }) => input.chain,
  direction: () => "buy",
  about: () => ({ kind: "cash", at: "aave" }),
  async describe({ chain, amount_usd }) {
    const amount = normalizeUsd(amount_usd);
    const rate = await supplyRate(chain).catch(() => null);
    return {
      summary: `Put ${dollars(amount)} into Aave savings on ${NETWORKS[chain].name}`,
      amountUsd: amount,
      // Aave's pool is fixed and reviewed, and pays its receipt token to the wallet itself.
      effect: {
        gives: [{ text: `${dollars(amount)} of USDC on ${NETWORKS[chain].name}` }],
        gets: [
          {
            text: `${dollars(amount)} in Aave savings${rate ? `, earning ${rate}% a year now` : ""}`,
          },
        ],
        grants: [],
      },
      card: supplyFace(NETWORKS[chain].name, rate),
    };
  },
  async execute({ input, wallets }) {
    const { chain } = input;
    const { pool } = AAVE[chain];
    const { usdc, viem } = NETWORKS[chain];
    const owner = wallets.evmAddress as Address;
    const amount = parseUnits(input.amount_usd, 6);
    // The pool can never pull more than this one supply.
    const approval = await exactApproval(chain, usdc, owner, pool, amount);
    const calls: EvmTx[] = [
      ...(approval ? [approval] : []),
      {
        to: pool,
        data: encodeFunctionData({
          abi: poolAbi,
          functionName: "supply",
          args: [usdc, amount, owner, 0],
        }),
      },
    ];
    const hash = await wallets.sendEvmTransaction(viem.id, calls).catch((error: unknown) => {
      throw refusal(error);
    });
    return { txs: [{ chain, hash }], fills: [savingsFill(chain, "buy", amount)] };
  },
  // What it supplied is the USDC its confirmed transaction took from the wallet.
  async readBack({ action, input: { chain }, evmAddress }) {
    const receipts = evmAddress ? await confirmedReceipts(chain, action.txs) : [];
    if (!evmAddress || receipts.length === 0) return null;
    const supplied = receipts
      .flatMap(({ logs }) => walletEffect(logs, evmAddress as Address).out)
      .filter((leg) => isAddressEqual(leg.token, NETWORKS[chain].usdc))
      .reduce((sum, leg) => sum + leg.amount, 0n);
    return { fills: [savingsFill(chain, "buy", supplied)] };
  },
};

/** Savings bought or sold, in the aToken the portfolio reads them as: a dollar each. */
function savingsFill(chain: EvmCashKey, side: Fill["side"], units: bigint): Fill {
  const quantity = formatUnits(units, 6);
  return { ...evmTokenKey(chain, AAVE[chain].aUsdc), side, quantity, usdValue: quantity };
}

export const aaveWithdraw: Recipe<typeof savingsInput> = {
  tool: "aave_withdraw",
  venue: "aave",
  description:
    "Withdraw USDC from Aave V3 savings on one chain back to the owner's wallet on that chain. " +
    "Pass the current savings balance to withdraw everything, including interest earned up to now.",
  input: savingsInput,
  direction: () => "sell",
  readies: ({ chain }) => chain,
  about: () => ({ kind: "cash", at: "aave" }),
  async describe({ chain, amount_usd }) {
    const amount = normalizeUsd(amount_usd);
    return {
      summary: `Withdraw ${dollars(amount)} from Aave savings on ${NETWORKS[chain].name}`,
      amountUsd: amount,
      effect: {
        gives: [{ text: `${dollars(amount)} of Aave savings on ${NETWORKS[chain].name}` }],
        gets: [{ text: `${dollars(amount)} of USDC` }],
        grants: [],
      },
      card: withdrawFace(NETWORKS[chain].name),
      // Execute withdraws this, or the whole balance when that is less.
      sells: { ...evmTokenKey(chain, AAVE[chain].aUsdc), quantity: amount_usd },
    };
  },
  async execute({ input, wallets }) {
    const { chain } = input;
    const { pool, aUsdc } = AAVE[chain];
    const { usdc, viem } = NETWORKS[chain];
    const owner = wallets.evmAddress as Address;
    const requested = parseUnits(input.amount_usd, 6);
    const balance = await publicClient(chain).readContract({
      address: aUsdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [owner],
    });
    // Asking for the whole balance (or more, as interest accrues between read
    // and send) withdraws everything, so no aToken dust is left behind.
    const all = requested >= balance;
    const hash = await wallets
      .sendEvmTransaction(viem.id, {
        to: pool,
        data: encodeFunctionData({
          abi: poolAbi,
          functionName: "withdraw",
          args: [usdc, all ? maxUint256 : requested, owner],
        }),
      })
      .catch((error: unknown) => {
        throw refusal(error);
      });
    return {
      txs: [{ chain, hash }],
      fills: [savingsFill(chain, "sell", all ? balance : requested)],
    };
  },
  // What it withdrew is the USDC its transaction paid the wallet: the whole balance, interest
  // included, when that was asked for.
  async readBack({ action, input: { chain }, evmAddress }) {
    const receipts = evmAddress ? await confirmedReceipts(chain, action.txs) : [];
    if (!evmAddress || receipts.length === 0) return null;
    const paid = await Promise.all(
      receipts.map((receipt) =>
        receivedBy(chain, receipt, NETWORKS[chain].usdc, evmAddress as Address),
      ),
    );
    return {
      fills: [
        savingsFill(
          chain,
          "sell",
          paid.reduce((sum, units) => sum + units, 0n),
        ),
      ],
    };
  },
};

/** The market's supply rate now, as a yearly percent to two places, e.g. "4.18". */
async function supplyRate(chain: EvmCashKey): Promise<string> {
  const reserve = await publicClient(chain).readContract({
    address: AAVE[chain].pool,
    abi: poolAbi,
    functionName: "getReserveData",
    args: [NETWORKS[chain].usdc],
  });
  // A ray (1e27) is 100%, so 1e23 is a hundredth of a percent.
  return formatUnits(reserve.currentLiquidityRate / 10n ** 23n, 2);
}
