import { NETWORKS, type EvmChainKey } from "@auni/shared";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Address } from "viem";

import { chains, Reverted, transferLog, type Contract } from "./chain.ts";

// The demo's Aave: its Pool on each chain (apps/aave/aave.ts), taking USDC in for its
// savings token one for one and paying it back the same way, at a fixed rate.

/** Aave V3's Pool and its USDC savings token, where Auni has a market. */
const MARKETS: Readonly<Partial<Record<EvmChainKey, { pool: Address; aUsdc: Address }>>> = {
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
};

const poolAbi = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function withdraw(address asset, uint256 amount, address to) returns (uint256)",
  "function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))",
]);
const ZERO: Address = "0x0000000000000000000000000000000000000000";
/** 4.1% a year, in Aave's 27-decimal rate. */
const RATE = 41n * 10n ** 24n;

for (const [name, market] of Object.entries(MARKETS)) {
  const chain = chains.get(name as EvmChainKey)!;
  const { pool, aUsdc } = market;
  const usdc = NETWORKS[name as EvmChainKey].usdc as Address;
  chain.list(aUsdc, { symbol: "aUSDC", name: "Aave USDC", decimals: 6 });
  const run: Contract = (call) => {
    const { functionName, args } = decodeFunctionData({ abi: poolAbi, data: call.data });
    if (functionName === "getReserveData")
      return {
        returned: encodeFunctionResult({
          abi: poolAbi,
          functionName,
          result: {
            configuration: 0n,
            liquidityIndex: 10n ** 27n,
            currentLiquidityRate: RATE,
            variableBorrowIndex: 10n ** 27n,
            currentVariableBorrowRate: 0n,
            currentStableBorrowRate: 0n,
            lastUpdateTimestamp: 0,
            id: 0,
            aTokenAddress: aUsdc,
            stableDebtTokenAddress: ZERO,
            variableDebtTokenAddress: ZERO,
            interestRateStrategyAddress: ZERO,
            accruedToTreasury: 0n,
            unbacked: 0n,
            isolationModeTotalDebt: 0n,
          },
        }),
        logs: [],
      };
    if (functionName === "supply") {
      const [asset, amount, onBehalfOf] = args;
      if (asset.toLowerCase() !== usdc.toLowerCase()) throw new Reverted("The pool takes USDC.");
      chain.spend(asset, call.from, pool, amount);
      const paid = chain.move(asset, call.from, aUsdc, amount);
      chain.credit(aUsdc, onBehalfOf, amount);
      return { returned: "0x", logs: [paid, transferLog(aUsdc, ZERO, onBehalfOf, amount)] };
    }
    const [asset, amount, to] = args;
    chain.credit(aUsdc, call.from, -amount);
    return {
      returned: encodeFunctionResult({ abi: poolAbi, functionName, result: amount }),
      logs: [transferLog(aUsdc, call.from, ZERO, amount), chain.move(asset, aUsdc, to, amount)],
    };
  };
  chain.deploy(pool, run);
}
