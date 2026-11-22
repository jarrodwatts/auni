import { NETWORKS, type EvmChainKey } from "@auni/shared";
import { encodeFunctionData, erc20Abi, parseUnits, type Address, type Hex } from "viem";

import { WALLET } from "./wallet.ts";
import { addressOf, chains } from "./world/chain.ts";
import { solana, SOLANA_USDC_MINT } from "./world/solana.ts";

// What the demo's owner brought with them, and how money reaches them from outside. Everything
// else they hold is the result of a move the seed plays through Auni (seed.ts).

/** Someone else's account, which pays the owner in: an exchange they withdrew from. */
const EXCHANGE = addressOf("an exchange");

/** What sat in the owner's wallets before Auni: a little of each chain's coin, and some SOL. */
export function fundWallet(): void {
  const coin = (chain: EvmChainKey, amount: string) =>
    chains.get(chain)!.credit("native", WALLET.evm, parseUnits(amount, 18));
  coin("monad", "150");
  coin("base", "0.02");
  coin("arbitrum", "0.01");
  coin("polygon", "6");
  solana.lamports = 6_500_000_000n;
  solana.tokens.set(SOLANA_USDC_MINT, { units: 120_000_000n, decimals: 6 });
}

/**
 * Sends the owner USDC from outside, as a withdrawal from an exchange lands: a transfer on the
 * demo's chain that core's own sweep then finds and tells them of. Its transaction hash.
 */
export function payIn(chain: EvmChainKey, usd: number): Hex {
  const ledger = chains.get(chain)!;
  const usdc = NETWORKS[chain].usdc as Address;
  const units = parseUnits(usd.toFixed(2), 6);
  ledger.credit(usdc, EXCHANGE, units);
  return ledger.send(EXCHANGE, [
    {
      to: usdc,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [WALLET.evm, units],
      }),
      value: 0n,
    },
  ]);
}
