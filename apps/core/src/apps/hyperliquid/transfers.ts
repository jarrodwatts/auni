import { NETWORKS } from "@auni/shared";
import { erc20Abi, formatUnits, parseUnits, type Address } from "viem";
import { z } from "zod";

import { publicClient } from "../../money/chains.ts";
import { usdLabel } from "../../money/format.ts";
import type { Recipe } from "../../money/recipe.ts";
import { dollars } from "../../money/summaries.ts";
import { centsToUsd, usdToCents } from "../../money/usd.ts";
import { evmAddress } from "../../money/wallets.ts";
import { info, nextNonce, sendUserSigned } from "./api.ts";
import { ensureUnifiedAccount, hyperliquidFreeCents } from "./account.ts";
import { depositFace, withdrawFace } from "./card.ts";
import { burnCalls, credited, forwardingFee, MINIMUM_DEPOSIT_USD } from "./cctp.ts";
import { sendRefusal } from "./problems.ts";
import { SIGNATURE_CHAIN_ID_HEX, WITHDRAW_FIELDS } from "./signing.ts";

// Hyperliquid pays a withdrawal out on Arbitrum from its own bridge there, the one its docs call
// legacy, which still paid within minutes on 2026-11-12. Deposits go by Circle's CCTP (cctp.ts).
export const WITHDRAWAL_FEE_USD = 1;
// Hyperliquid keeps a flat $1 of every withdrawal, so one has to be over $2 for more than $1 to arrive.
const MINIMUM_WITHDRAWAL_USD = WITHDRAWAL_FEE_USD + 1;

const depositInput = {
  amountUsd: z
    .number()
    .min(MINIMUM_DEPOSIT_USD)
    .describe(`USDC to move from Arbitrum into Hyperliquid. At least ${MINIMUM_DEPOSIT_USD}.`),
};

/** Dollars as USDC units, and back. */
const usdc = (amountUsd: number) => parseUnits(amountUsd.toFixed(6), 6);
const dollarsOf = (units: bigint) => Number(formatUnits(units, 6));

export const hyperliquidDeposit: Recipe<typeof depositInput> = {
  tool: "hyperliquid_deposit",
  description:
    `Deposit USDC from the owner's wallet on Arbitrum into their Hyperliquid account. It goes by Circle's CCTP, which keeps a flat fee (about $0.20) of what is sent, so a little less arrives than leaves: the card says both. Minimum ${MINIMUM_DEPOSIT_USD} USDC. Credits in about a minute. ` +
    "It stays running until Hyperliquid credits it, and this thread is woken then, so never sleep or poll to check on it.",
  input: depositInput,
  venue: "hyperliquid",
  fundedFrom: () => "arbitrum",
  readies: () => "hyperliquid",
  about: () => ({ kind: "cash", at: "hyperliquid" }),

  async describe(deposit) {
    const amount = usdc(deposit.amountUsd);
    const fee = await forwardingFee(amount);
    if (fee >= amount) {
      throw new Error(
        `The fee for moving USDC into Hyperliquid is ${usdLabel(dollarsOf(fee))} now, as much as this would send, so nothing would arrive.`,
      );
    }
    const arrives = usdLabel(dollarsOf(amount - fee));
    return {
      summary: `Move ${usdLabel(deposit.amountUsd)} of USDC from Arbitrum into Hyperliquid`,
      amountUsd: deposit.amountUsd.toFixed(2),
      // Burned for Circle's forwarder, which credits the owner's own account: Auni reads the
      // account until it lands (see landed).
      effect: {
        gives: [{ text: `${usdLabel(deposit.amountUsd)} of USDC on Arbitrum` }],
        gets: [{ text: arrives, lands: "on Hyperliquid in ~1 min" }],
        grants: [],
        costs: [{ label: "Circle's fee", usd: dollarsOf(fee) }],
      },
      // Where it lands, so the card's steps say where it is on its way to; and the most that
      // may be kept of it on the way, which is all execute lets be kept.
      details: { arrivesOn: "Hyperliquid", feeUnits: String(fee) },
      card: depositFace({ from: NETWORKS.arbitrum.name, arrives, fee: usdLabel(dollarsOf(fee)) }),
    };
  },

  async execute({ action, input: deposit, wallets }) {
    const amount = usdc(deposit.amountUsd);
    const { viem } = NETWORKS.arbitrum;
    const balance = await publicClient("arbitrum").readContract({
      address: NETWORKS.arbitrum.usdc,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallets.evmAddress as `0x${string}`],
    });
    if (balance < amount) {
      throw new Error(
        `The wallet holds ${(Number(balance) / 1e6).toFixed(2)} USDC on Arbitrum, less than the ${deposit.amountUsd.toFixed(2)} to deposit.`,
      );
    }
    // Never more kept than the card showed. A fee that has risen since would leave the burn
    // underpaid, so it stops here with nothing sent.
    const shown = BigInt(action.details.feeUnits ?? "0");
    const now = await forwardingFee(amount);
    if (now > shown) {
      throw new Error(
        `The fee for moving this into Hyperliquid rose from ${usdLabel(dollarsOf(shown))} to ${usdLabel(dollarsOf(now))} since the card was made, so nothing was sent. Ask for a fresh card.`,
      );
    }
    const hash = await wallets
      .sendEvmTransaction(viem.id, burnCalls(wallets.evmAddress as Address, amount, shown))
      .catch((error: unknown) => {
        throw sendRefusal(error);
      });
    return {
      txs: [{ chain: "arbitrum", hash }],
      fills: [],
      run: { lands: `${usdLabel(dollarsOf(amount - shown))} on Hyperliquid` },
    };
  },

  async landed({ action, input: deposit, evmAddress }) {
    const hash = action.txs.findLast((tx) => !tx.setup && tx.hash)?.hash;
    if (!hash) return null;
    return credited({
      hash,
      owner: evmAddress,
      amount: usdc(deposit.amountUsd),
      since: (action.startedAt ?? action.createdAt).getTime(),
    });
  },
};

const withdrawInput = {
  amountUsd: z
    .number()
    .gt(MINIMUM_WITHDRAWAL_USD)
    .optional()
    .describe(
      "USDC leaving Hyperliquid. The venue keeps a flat $1 fee; the rest lands on Arbitrum. Leave it out to withdraw all free cash; positions keep their margin.",
    ),
};

export const hyperliquidWithdraw: Recipe<typeof withdrawInput> = {
  tool: "hyperliquid_withdraw",
  description:
    "Withdraw free USDC from Hyperliquid to the owner's own wallet on Arbitrum. Hyperliquid keeps a flat $1 fee. Leave amountUsd out to withdraw all free cash; positions keep their margin. " +
    "It stays running until the USDC reaches Arbitrum, usually a few minutes, and this thread is woken then, so never sleep or poll to check on it. " +
    "As a leg on one card it pays for what's bought elsewhere: it runs before every other leg, and what it lands on Arbitrum moves on from there. " +
    "So it can't take what a close on the same card frees: close first, and withdraw once you're woken with that settled.",
  input: withdrawInput,
  venue: "hyperliquid",
  fundedFrom: () => "hyperliquid",
  readies: () => "arbitrum",
  about: () => ({ kind: "cash", at: "hyperliquid" }),

  async describe({ amountUsd }) {
    const all = amountUsd === undefined;
    const owner = await evmAddress();
    const free = owner ? await hyperliquidFreeCents(owner) : 0n;
    const cents = withdrawalCents(all ? free : centsOf(amountUsd), free);
    const amount = dollars(centsToUsd(cents));
    return {
      summary: all
        ? `Bring all free cash (${amount}) back from Hyperliquid to Arbitrum`
        : `Bring ${amount} back from Hyperliquid to Arbitrum`,
      amountUsd: centsToUsd(cents),
      // Signed to the owner's own address, which Hyperliquid pays on Arbitrum (see landed).
      effect: {
        gives: [{ text: `${amount} of Hyperliquid cash` }],
        gets: [{ text: arrives(cents), lands: "in a few minutes" }],
        grants: [],
        costs: [{ label: "Hyperliquid fee", usd: WITHDRAWAL_FEE_USD }],
      },
      // Where it lands, so the card's steps say where it is on its way to.
      details: { arrivesOn: NETWORKS.arbitrum.name },
      card: withdrawFace({
        to: NETWORKS.arbitrum.name,
        arrives: dollars(centsToUsd(cents - centsOf(WITHDRAWAL_FEE_USD))),
        fee: dollars(String(WITHDRAWAL_FEE_USD)),
        all,
      }),
    };
  },

  async execute({ action, input: withdraw, wallets, posting }) {
    const user = wallets.evmAddress;
    const free = await hyperliquidFreeCents(user);
    // Never more than the card showed. Withdrawing all showed what was free when the card was
    // made, so if some of that has gone since, it takes what is left.
    const shown = usdToCents(action.amountUsd);
    const cents = withdrawalCents(
      withdraw.amountUsd === undefined && free < shown ? free : shown,
      free,
    );
    // Unified, the account's free cash is one balance withdraw3 draws on, wherever it sat before.
    // Switching gathers exactly the free cash read above, and only once the withdrawal will go.
    await ensureUnifiedAccount(wallets);
    const time = nextNonce();
    await posting("hyperliquid", () =>
      sendUserSigned(wallets, "Withdraw", WITHDRAW_FIELDS, {
        type: "withdraw3",
        signatureChainId: SIGNATURE_CHAIN_ID_HEX,
        hyperliquidChain: "Mainnet",
        destination: user.toLowerCase(),
        amount: centsToUsd(cents),
        time,
      }),
    );
    return {
      txs: [],
      fills: [],
      // Hyperliquid's bridge pays it from a transaction of its own, whose hash Hyperliquid
      // never says, so it is known by exactly what it pays: USDC to the micro-dollar.
      run: {
        lands: arrives(cents),
        landsUnits: String((cents - centsOf(WITHDRAWAL_FEE_USD)) * 10_000n),
        nonce: String(time),
      },
    };
  },

  // The ledger lists a withdrawal only once the bridge has paid it out on Arbitrum, so listed is
  // landed. It keeps the nonce in microseconds, though the withdrawal was signed in milliseconds.
  async landed({ action, evmAddress }) {
    const nonce = Number(action.run.nonce);
    if (!nonce) return null;
    const updates = await ledgerSince(evmAddress, nonce);
    return updates.some(
      (update) => update.delta.type === "withdraw" && update.delta.nonce === nonce * 1000,
    )
      ? {}
      : null;
  },
};

function centsOf(amountUsd: number): bigint {
  return BigInt(Math.round(amountUsd * 100));
}

/**
 * Withdrawing `cents` of the `free` cents Hyperliquid can pay out, refused
 * before anything is signed when it's more than is free, or too little to
 * leave anything after the fee.
 */
function withdrawalCents(cents: bigint, free: bigint): bigint {
  if (cents > free) {
    throw new Error(
      `Hyperliquid has ${dollars(centsToUsd(free))} free to bring back; open positions hold the rest as margin.`,
    );
  }
  if (cents <= centsOf(MINIMUM_WITHDRAWAL_USD)) {
    throw new Error(
      `Hyperliquid has ${dollars(centsToUsd(free))} free to bring back; bringing cash back has to be over $2, since Hyperliquid keeps $1 of it.`,
    );
  }
  return cents;
}

/** What a withdrawal of `cents` lands on Arbitrum once Hyperliquid keeps its fee. */
function arrives(cents: bigint): string {
  return `${dollars(centsToUsd(cents - centsOf(WITHDRAWAL_FEE_USD)))} on Arbitrum`;
}

/** The account's deposits, withdrawals and transfers since `startTime`, oldest first. */
function ledgerSince(user: string, startTime: number) {
  return info<
    readonly {
      readonly hash: string;
      readonly delta: { readonly type: string; readonly nonce?: number; readonly usdc?: string };
    }[]
  >({ type: "userNonFundingLedgerUpdates", user, startTime });
}
