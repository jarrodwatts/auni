"use client";

import type { ActionStatus } from "@auni/shared";
import { ArrowRight, LoaderCircle, WalletMinimal } from "lucide-react";
import { useState } from "react";

import {
  auniDialogOutlineButtonClass,
  auniDialogPrimaryButtonClass,
} from "@/components/ui/auni-dialog";
import { Button } from "@/components/ui/button";
import { CoreApiError } from "@/lib/core";
import { decideAction, NOT_REACHED, readAction } from "@/lib/data/actions";
import {
  placeName,
  WITHDRAW_NETWORKS,
  withdrawalDetails,
  type Withdrawal,
} from "@/lib/data/withdrawals";
import { formatUsd } from "@/lib/money";
import { cn } from "@/lib/utils";

import { mustPairAgain, PairAgain } from "@/components/auth/pair-again";
import { FullAddress } from "@/components/cards/money/full-address";
import { ProofNote } from "@/components/cards/money/proof-note";
import { shortAddress } from "@/components/money/portal/deposit-addresses";

import { PlaceMark } from "./place-mark";

// An Allow that went through: the withdrawal is on its way or already settled.
const SENT: ReadonlySet<ActionStatus> = new Set(["running", "done", "failed"]);

/** Why a tap on Withdraw didn't go through, in the person's words. */
function refusal(error: unknown): string {
  return error instanceof CoreApiError && error.detail
    ? error.detail
    : "Couldn't reach Auni. Nothing was sent. Try again.";
}

/**
 * The confirm step every withdrawal passes, from Withdraw or from chat: the route as a scene
 * (their wallet, the amount, whose place it lands in and on which network), the full address with the parts people check in
 * bold, a plain warning when it looks like an address they used before, what it costs and when
 * it lands, and the proof a new address takes, that the owner is at the computer, before the tap
 * can send. What the tap sends is the action core recorded; this only shows it.
 */
export function WithdrawReview({
  withdrawal,
  onSent,
  onBack,
  backLabel = "Back",
  className,
}: {
  readonly className?: string;
  readonly withdrawal: Withdrawal;
  readonly onSent: (action: Withdrawal["action"]) => void;
  readonly onBack: () => void;
  readonly backLabel?: string;
}) {
  const { action, review } = withdrawal;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // This browser has no proof to give that the owner is here: the way on is to pair it again.
  const [pairAgain, setPairAgain] = useState(false);
  const amount = formatUsd(action.amountUsd);
  const pinned = withdrawalDetails(action);
  const network =
    WITHDRAW_NETWORKS.find((entry) => entry.id === review.network)?.name ?? pinned.network;
  const takesProof = review.newAddress;

  const send = async () => {
    setBusy(true);
    setError(null);
    setPairAgain(false);
    try {
      // A tap after one that went through comes back as the withdrawal now stands.
      const now = await decideAction(action.id, "allow");
      if (SENT.has(now.status)) onSent(now);
      else setError("This withdrawal is no longer waiting. Nothing new was sent.");
    } catch (caught) {
      // This browser has no proof to give that the owner is here: nothing was sent.
      if (mustPairAgain(caught)) return void setPairAgain(true);
      // A lost answer: the withdrawal itself says whether it went.
      const unsure = !(caught instanceof CoreApiError) || caught.status >= 500;
      const now = unsure ? await readAction(action.id).catch(() => null) : undefined;
      if (now && SENT.has(now.status)) onSent(now);
      else setError(unsure && now === null ? NOT_REACHED : refusal(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn("flex flex-col", className)}>
      {/* The route, as a scene: from the owner's wallet, the amount, to where it lands. */}
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-col items-center gap-1.5">
          <span className="grid size-10 place-items-center rounded-full bg-foreground/[0.06] text-ink">
            <WalletMinimal aria-hidden className="size-[18px]" />
          </span>
          <span className="text-meta text-muted-foreground">Your wallet</span>
        </span>
        <span className="relative flex min-w-0 flex-1 flex-col items-center pb-6">
          <span className="text-card-money text-ink tabular-nums">{amount}</span>
          <span aria-hidden className="absolute bottom-3 left-0 h-px w-full bg-border" />
          <ArrowRight
            aria-hidden
            className="absolute right-0 bottom-[5px] size-4 translate-x-1 text-muted-foreground"
          />
        </span>
        <span className="flex min-w-0 flex-col items-center gap-1.5">
          <PlaceMark destination={review.destination} network={review.network} size={40} />
          <span className="text-meta whitespace-nowrap text-muted-foreground">
            {sentenceCase(placeName(review.destination) ?? "this address")}
          </span>
        </span>
      </div>

      {/* Two even lines, so a phone never wraps it mid-way; the start and end people check stand out. */}
      <p className="mt-5 rounded-control bg-surface px-3 py-3 text-center text-ui leading-6">
        <FullAddress address={review.address} />
      </p>

      {review.lookalike ? (
        <p
          role="alert"
          className="mt-3 rounded-control border border-negative/30 px-3.5 py-3 text-meta text-negative"
        >
          This looks like {shortAddress(review.lookalike)}, an address you sent to before, but the
          middle is different. Scammers plant addresses like this. Check every character before you
          send.
        </p>
      ) : review.destination === "exchange" ? (
        <p className="mt-3 text-meta text-muted-foreground">
          Check that your exchange takes USDC on {network}. Money sent on a network it doesn&apos;t
          support can be lost.
        </p>
      ) : null}

      <dl className="mt-4 divide-y divide-border text-ui">
        {[
          ["Network", network],
          // What lands and when: less the fee, where it moves between networks.
          [
            "Arrives",
            pinned.lands && pinned.arrives
              ? `About ${pinned.lands}, ${pinned.arrives.toLowerCase()}`
              : pinned.arrives,
          ],
          ["Fee", pinned.fee],
          ["SOL for fees", pinned.solForFees],
        ].map(([label, value]) =>
          value ? (
            <div key={label} className="flex items-center justify-between py-2.5">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium text-ink tabular-nums">{value}</dd>
            </div>
          ) : null,
        )}
      </dl>

      {pairAgain ? (
        <PairAgain className="mt-3" then="Then tap Withdraw again. Nothing was sent." />
      ) : takesProof ? (
        <ProofNote className="mt-3">
          This is a new address, so Auni checks it&apos;s you first.
        </ProofNote>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-meta text-negative">
          {error}
        </p>
      ) : null}

      <div className="mt-6 grid grid-cols-[auto_1fr] gap-3">
        <Button
          className={cn(auniDialogOutlineButtonClass, "px-6")}
          disabled={busy}
          onClick={onBack}
          type="button"
          variant="secondary"
        >
          {backLabel}
        </Button>
        <Button
          className={auniDialogPrimaryButtonClass}
          disabled={busy}
          onClick={() => void send()}
          type="button"
        >
          {busy ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
          Withdraw {amount}
        </Button>
      </div>
    </div>
  );
}

function sentenceCase(words: string): string {
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
