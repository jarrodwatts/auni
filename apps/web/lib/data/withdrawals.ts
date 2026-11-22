import {
  NETWORKS,
  WITHDRAW_NETWORKS as NETWORK_IDS,
  withdrawalWireSchema,
  withdrawCashWireSchema,
  type ActionRecordId,
  type ActionWire,
  type WithdrawalWire,
  type WithdrawCashWire,
  type WithdrawNetwork,
} from "@auni/shared";
import { isAddress } from "viem";

import { requestCore } from "@/lib/core";
import { formatUsd } from "@/lib/money";

/**
 * Withdraw: the cash that can leave, the proposal core records and prices,
 * and what the confirm step shows. Its Allow and Decline are every action
 * card's (decideAction), with the proof a new address takes that the owner is there.
 */

/** Every network core withdraws to, in its order, by name. */
export const WITHDRAW_NETWORKS = NETWORK_IDS.map((id) => ({ id, name: NETWORKS[id].name }));
export type { WithdrawNetwork };
export type WithdrawDestination = NonNullable<WithdrawalWire["review"]["destination"]>;
export type Withdrawal = WithdrawalWire;
type WithdrawCash = WithdrawCashWire;

/**
 * What a withdrawal's confirm step and receipt say beside its card, as the withdraw recipe
 * pinned them: the network, when it lands, and each fee it pays.
 */
export function withdrawalDetails({ details }: Pick<ActionWire, "details">): {
  readonly network: string | undefined;
  readonly arrives: string | undefined;
  /** What moving it between networks costs: "$0.07". */
  readonly fee: string | undefined;
  /** The cash that buys the SOL a Solana send needs, most of which stays as SOL: "$1". */
  readonly solForFees: string | undefined;
} {
  const { network, arrives, fee, solForFees } = details;
  return { network, arrives, fee, solForFees };
}

/** A quick shape check while typing; core checks for real (checksums, token contracts). */
export function addressFits(network: WithdrawNetwork, value: string): boolean {
  const trimmed = value.trim();
  return network === "solana"
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(trimmed)
    : isAddress(trimmed, { strict: false });
}

/**
 * What Withdraw says of the owner's cash: all of it, as the portfolio's Cash says, then, where
 * an app keeps some, how much is in their wallet to send and where the rest is.
 */
export function cashWords({ cashUsd, walletUsd, elsewhere }: WithdrawCash): string {
  const ask = "Holdings sell to cash first: ask Auni.";
  if (elsewhere.length === 0) return `You have ${formatUsd(cashUsd)} in cash. ${ask}`;
  const at = elsewhere.map(({ name, usdValue }) => `${formatUsd(usdValue)} at ${name}`);
  const rest = at.length === 1 ? at[0] : `${at.slice(0, -1).join(", ")} and ${at.at(-1)}`;
  return (
    `You have ${formatUsd(cashUsd)} in cash: ${formatUsd(walletUsd)} in your wallet to send, ` +
    `and ${rest}. Ask Auni to bring that home, or to sell holdings to cash.`
  );
}

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });

/**
 * What Withdraw says once the owner allowed it, from the withdrawal as it stands now (`now`, which
 * the dialog reads again while it runs): on its way, when it lands; that it arrived, where and
 * when, once done; or that it didn't go through, and why.
 */
export function sentWords(
  { review }: Pick<Withdrawal, "review">,
  now: Pick<ActionWire, "status" | "amountUsd" | "details" | "error" | "updatedAt">,
): { readonly title: string; readonly lede: string } {
  if (now.status === "failed")
    return { title: "It didn’t go through", lede: now.error ?? "Try again in a moment." };
  if (now.status !== "done")
    return { title: "On its way", lede: `${withdrawalDetails(now).arrives ?? "Soon"}.` };
  const network = WITHDRAW_NETWORKS.find((entry) => entry.id === review.network)?.name;
  const to = review.destination ? `your ${review.destination}` : "that address";
  // "4:04pm", as Activity says a time.
  const at = TIME.format(new Date(now.updatedAt)).replace(
    /\s([AP])M$/u,
    (_, half: string) => `${half.toLowerCase()}m`,
  );
  return {
    title: "It arrived",
    lede: `${formatUsd(now.amountUsd)} reached ${to}${network ? ` on ${network}` : ""} at ${at}.`,
  };
}

export async function readWithdrawCash(signal?: AbortSignal): Promise<WithdrawCash> {
  return withdrawCashWireSchema.parse(
    await requestCore("withdrawals/cash", { method: "GET", signal }),
  );
}

export async function proposeWithdrawal(request: {
  readonly amountUsd: string;
  readonly network: WithdrawNetwork;
  readonly address: string;
  readonly destination: WithdrawDestination;
}): Promise<Withdrawal> {
  return withdrawalWireSchema.parse(
    await requestCore("withdrawals", {
      method: "POST",
      body: JSON.stringify({
        amount_usd: request.amountUsd,
        network: request.network,
        address: request.address.trim(),
        destination: request.destination,
      }),
    }),
  );
}

export async function readWithdrawal(
  actionReference: ActionRecordId | string,
  signal?: AbortSignal,
): Promise<Withdrawal> {
  return withdrawalWireSchema.parse(
    await requestCore(`withdrawals/${actionReference}`, { method: "GET", signal }),
  );
}
