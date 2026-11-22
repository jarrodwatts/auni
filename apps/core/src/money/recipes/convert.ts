import { CASH_KEYS, isEvmChain, NETWORKS, type NetworkKey } from "@auni/shared";

import { z } from "zod";

import { APPROVED_PROCEEDS } from "../approved.ts";
import { chainName } from "../chains.ts";
import { EVM_NATIVE, QUANTITY_DECIMALS, tokenKey, WRAPPED_SOL } from "../fill-key.ts";
import { heldNow } from "../portfolio.ts";
import { tradedToken, type ActionPreview, type Recipe } from "../recipe.ts";
import { dollars } from "../summaries.ts";
import { centsToUsd, formatUnits, parseUnits } from "../usd.ts";
import { evmAddress, solanaAddress } from "../wallets.ts";
import { executeEvmSwap, previewEvmSwap } from "../swaps/evm-swap.ts";
import { executeSolanaSwap, previewSolanaSwap } from "../swaps/solana-swap.ts";

// A holding turned into USDC where it sits, to pay for a card's picks: code
// puts it on the card (see pay-with-holdings.ts), and it runs on the tap,
// before the picks, as savings coming out does. It is a swap into USDC
// underneath, held to what its card showed in the same ways.

/**
 * The significant digits a JavaScript number carries exactly. The swaps a
 * conversion runs on take their amount as one, and a longer amount rounds to
 * the nearest, which can be a few base units past what may be sold.
 */
const EXACT_DIGITS = 15;

/** Base units rounded down to what a swap's number carries exactly. */
export function floatExact(units: bigint): bigint {
  const extra = units.toString().length - EXACT_DIGITS;
  if (extra <= 0) return units;
  const step = 10n ** BigInt(extra);
  return (units / step) * step;
}

const input = {
  chain: z.enum(CASH_KEYS),
  /** As a holding names it: an address, a mint, or "native" for the chain's own coin. */
  token: z.string().min(1),
  /** In whole units, as the wallet shows it, no more digits than a swap's number carries (see floatExact). */
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/u)
    .refine(
      (amount) =>
        amount.replace(".", "").replace(/^0+/u, "").replace(/0+$/u, "").length <= EXACT_DIGITS,
      `At most ${EXACT_DIGITS} significant digits.`,
    ),
};

type Conversion = z.infer<z.ZodObject<typeof input>>;

/** How far under its quote a conversion may fill. */
const SLIPPAGE_BPS = 100n;

/** Refuses a conversion of more than the wallet holds, read fresh. */
async function assertHeld({ chain, token, amount }: Conversion): Promise<void> {
  const held = await heldNow(tokenKey(chain, token));
  if (held === null) throw new Error(`The ${chainName(chain)} wallet couldn't be read.`);
  if (parseUnits(amount, QUANTITY_DECIMALS) > held)
    throw new Error(
      `Only ${formatUnits(held, QUANTITY_DECIMALS)} of it on ${chainName(chain)} is held now. Nothing was sent.`,
    );
}

function evmSwapOf({ chain, token, amount }: Conversion) {
  if (!isEvmChain(chain)) throw new Error(`${chain} isn't an EVM chain.`);
  return {
    chain,
    sellToken: token === "native" ? EVM_NATIVE : token,
    buyToken: NETWORKS[chain].usdc,
    sellAmount: Number(amount),
    slippageBps: Number(SLIPPAGE_BPS),
  };
}

function solanaSwapOf({ token, amount }: Conversion) {
  return {
    token: token === "native" ? WRAPPED_SOL : token,
    side: "sell" as const,
    tokenAmount: Number(amount),
    slippageBps: Number(SLIPPAGE_BPS),
  };
}

/** A card without its own face, so the plain one core makes says what it does. */
const withoutFace = ({ card: _, ...preview }: ActionPreview): ActionPreview => preview;

/**
 * A swap into USDC as a conversion's card shows it. Its amountUsd is the
 * least USDC it can land: a fresh quote under what the card says it gets at
 * least is refused, and the fill lands at most its slippage under that, so
 * a card spends no more than this of it. Code picks what pays, not the
 * person, so one that loses past its venue's limit the moment it fills is
 * refused: a card never pays with a bad trade.
 */
export function asConversion(chain: NetworkKey, swap: ActionPreview): ActionPreview {
  const details = swap.details ?? {};
  const { sell, returnsUsd } = details;
  const least = details[APPROVED_PROCEEDS];
  if (swap.unpriced || !sell || !returnsUsd || !least)
    throw new Error("Converting it would lose too much the moment it fills.");
  const lands = (parseUnits(least, 6) * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  // The swap's card but its face, which says a sale: with all core reads of it as the card is
  // prepared, what it sends and the SOL it buys (ActionPreview.buysSol), which a card buys once.
  return {
    ...withoutFace(swap),
    summary: `Convert ${sell} on ${chainName(chain)} to about ${dollars(returnsUsd)} of USDC`,
    amountUsd: centsToUsd(lands / 10_000n),
  };
}

export const convertToCash: Recipe<typeof input> = {
  tool: "convert_to_cash",
  description:
    "Turns a wallet holding into USDC on its own chain, to pay for a card's picks. Code puts it on a card; the agent never calls it.",
  input,
  venue: "auni",
  readies: ({ chain }) => chain,
  about: ({ details }) => tradedToken(details, 0),
  async describe(conversion) {
    await assertHeld(conversion);
    const swap =
      conversion.chain === "solana"
        ? await previewSolanaSwap(solanaSwapOf(conversion), {
            owner: solanaAddress,
          })
        : await previewEvmSwap(evmSwapOf(conversion), evmAddress, {
            mustHold: true,
          });
    return asConversion(conversion.chain, swap);
  },
  async execute({ action, input: conversion, wallets }) {
    // What was there may have left the wallet since the card was made.
    await assertHeld(conversion);
    return conversion.chain === "solana"
      ? executeSolanaSwap(solanaSwapOf(conversion), wallets, action)
      : executeEvmSwap(evmSwapOf(conversion), wallets, action);
  },
};
