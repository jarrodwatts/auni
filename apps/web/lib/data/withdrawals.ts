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
/** A place the owner's money went before, which Withdraw offers again. */
export type RecentPlace = WithdrawCashWire["recent"][number];

/**
 * What a withdrawal's confirm step and receipt say beside its card, as the withdraw recipe
 * pinned them: the network, when it lands, and each fee it pays.
 */
export function withdrawalDetails({ details }: Pick<ActionWire, "details">): {
  readonly network: string | undefined;
  readonly arrives: string | undefined;
  /** What moving it between networks costs, taken from what lands: "$0.07". */
  readonly fee: string | undefined;
  /** What lands once that fee is taken, as the bridge quoted it: "$19.93". */
  readonly lands: string | undefined;
  /** The cash that buys the SOL a Solana send needs, most of which stays as SOL: "$1". */
  readonly solForFees: string | undefined;
} {
  const { network, arrives, fee, landsUsd, solForFees } = details;
  const lands = fee && landsUsd ? formatUsd(landsUsd) : undefined;
  return { network, arrives, fee, lands, solForFees };
}

/** A quick shape check while typing; core checks for real (checksums, token contracts). */
export function addressFits(network: WithdrawNetwork, value: string): boolean {
  const trimmed = value.trim();
  return network === "solana"
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(trimmed)
    : isAddress(trimmed, { strict: false });
}

/** Whose a place is, as Withdraw names it: the owner's other wallet is never "your wallet", Auni's. */
export function placeName(destination: WithdrawDestination | null | undefined): string | null {
  return destination === "exchange"
    ? "your exchange"
    : destination === "wallet"
      ? "your other wallet"
      : null;
}

/** Whether two places are one: by network and address, never by which read of them it was. */
export function samePlace(
  a: Pick<RecentPlace, "network" | "address">,
  b: Pick<RecentPlace, "network" | "address">,
): boolean {
  return a.network === b.network && a.address === b.address;
}

/** The dollars typed as the amount, without the "$", commas or spaces people type with them. */
export function typedDollars(amount: string): string {
  return amount.replace(/[$,\s]/gu, "");
}

/**
 * What Withdraw says of the owner's cash under the amount, for `typed` dollars on `network`: just
 * what's in their wallet, until that's more than one withdrawal can send there (what Max fills),
 * or nothing can leave there at all. Then it says how far it goes, and the way to send more: the
 * network their cash leaves from, gathering it first, or bringing home what an app keeps.
 */
export function cashWords(
  { walletUsd, elsewhere, maxUsd }: WithdrawCash,
  network: WithdrawNetwork,
  typed: string,
): { readonly words: string; readonly over: boolean } {
  const dollars = Number(typedDollars(typed)) || 0;
  const max = maxUsd[network] ?? walletUsd;
  const over = dollars > Number(max);
  if (!over && Number(max) > 0)
    return { words: `${formatUsd(walletUsd)} USDC in your wallet.`, over };
  // Where one withdrawal sends the most, as Solana's cash leaves only on Solana.
  const best = WITHDRAW_NETWORKS.reduce((a, b) =>
    Number(maxUsd[b.id] ?? 0) > Number(maxUsd[a.id] ?? 0) ? b : a,
  );
  const bestMax = maxUsd[best.id] ?? "0";
  const limit = `One withdrawal on ${NETWORKS[network].name} can send up to ${formatUsd(max)}.`;
  const words =
    Number(bestMax) <= 0
      ? `No USDC in your wallet. ${fromElsewhere(elsewhere)}`
      : Number(max) <= 0
        ? `Your cash is on ${best.name}. Pick ${best.name} to withdraw it.`
        : best.id !== network && dollars <= Number(bestMax)
          ? `${limit} Pick ${best.name} to send up to ${formatUsd(bestMax)}.`
          : `${limit} ${dollars <= Number(walletUsd) ? "Ask Auni to gather the rest first." : fromElsewhere(elsewhere)}`;
  return { words, over };
}

/** How cash beyond the wallet's comes to it: from the apps keeping some, or by selling first. */
function fromElsewhere(elsewhere: WithdrawCash["elsewhere"]): string {
  if (elsewhere.length === 0) return "To withdraw other holdings, ask Auni to sell them first.";
  const at = elsewhere.map(({ name, usdValue }) => `${formatUsd(usdValue)} on ${name}`);
  const rest = at.length === 1 ? at[0] : `${at.slice(0, -1).join(", ")} and ${at.at(-1)}`;
  return `${rest}: ask Auni to move it back first.`;
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
  const amount = formatUsd(now.amountUsd);
  // A withdrawal moved between networks lands less its fee, as the bridge quoted it.
  const { arrives, fee, lands } = withdrawalDetails(now);
  if (now.status === "failed")
    return {
      title: "Withdrawal didn't go through",
      lede: now.error ?? "Your money stayed in your wallet. Try again in a moment.",
    };
  // One quoted before what lands was kept says only that the fee comes out of it.
  const less = fee && !lands ? `, less the ${fee} fee to move it between networks` : "";
  if (now.status !== "done") {
    const when = arrives ? `arrives ${arrives.toLowerCase()}` : "should arrive soon";
    return {
      title: `${amount} on its way`,
      lede: lands
        ? `About ${lands} ${when}, after the ${fee} fee to move it between networks.`
        : `${when.charAt(0).toUpperCase()}${when.slice(1)}${less}.`,
    };
  }
  const network = WITHDRAW_NETWORKS.find((entry) => entry.id === review.network)?.name;
  const to = placeName(review.destination) ?? "that address";
  // "4:04pm", as Activity says a time.
  const at = TIME.format(new Date(now.updatedAt)).replace(
    /\s([AP])M$/u,
    (_, half: string) => `${half.toLowerCase()}m`,
  );
  return {
    title: lands ? `About ${lands} arrived` : fee ? `${amount} sent` : `${amount} arrived`,
    lede:
      `Reached ${to}${network ? ` on ${network}` : ""} at ${at}${less}.` +
      (lands ? ` ${amount} left your wallet, and moving it between networks cost ${fee}.` : ""),
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
  readonly destination: WithdrawDestination | null;
}): Promise<Withdrawal> {
  return withdrawalWireSchema.parse(
    await requestCore("withdrawals", {
      method: "POST",
      body: JSON.stringify({
        amount_usd: request.amountUsd,
        network: request.network,
        address: request.address.trim(),
        // Left out when the owner didn't say whose it is.
        destination: request.destination ?? undefined,
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
