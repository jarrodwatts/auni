"use client";

import type { ActionStatus } from "@auni/shared";
import { LoaderCircle } from "lucide-react";
import { useState } from "react";

import {
  auniDialogOutlineButtonClass,
  auniDialogPrimaryButtonClass,
} from "@/components/ui/auni-dialog";
import { Button } from "@/components/ui/button";
import { CoreApiError } from "@/lib/core";
import { decideAction, NOT_REACHED, readAction } from "@/lib/data/actions";
import { WITHDRAW_NETWORKS, withdrawalDetails, type Withdrawal } from "@/lib/data/withdrawals";
import { formatUsd } from "@/lib/money";

import { mustPairAgain, PairAgain } from "@/components/auth/pair-again";
import { FullAddress } from "@/components/cards/money/full-address";
import { ProofNote } from "@/components/cards/money/proof-note";

// An Allow that went through: the withdrawal is on its way or already settled.
const SENT: ReadonlySet<ActionStatus> = new Set(["running", "done", "failed"]);

/** Why a tap on Withdraw didn't go through, in the person's words. */
function refusal(error: unknown): string {
  return error instanceof CoreApiError && error.detail
    ? error.detail
    : "That didn't reach Auni. Nothing was sent, so try again.";
}

/**
 * The confirm step every withdrawal passes, from Settings or from chat: the
 * full address with the parts people check in bold, a plain warning when it
 * looks like an address they used before, and the proof a new address
 * takes, that the owner is at the computer, before the tap can send.
 */
export function WithdrawReview({
  withdrawal,
  onSent,
  onBack,
  backLabel = "Back",
}: {
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
      else setError("This withdrawal already moved on. Nothing new was sent.");
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
    <div className="flex flex-col">
      <div className="text-center">
        <p className="text-card-money text-ink">{amount}</p>
        <p className="mt-1 text-ui text-muted-foreground">
          {review.destination ? `to your ${review.destination}` : "to this address"} on {network}
        </p>
      </div>

      {/* Two even lines, so a phone never wraps it mid-way; the start and end people check stand out. */}
      <p className="mt-5 rounded-control border border-foreground/[0.1] bg-surface px-3 py-3 text-center text-ui leading-[1.6]">
        <FullAddress address={review.address} />
      </p>

      {review.lookalike ? (
        <p
          role="alert"
          className="mt-3 rounded-control bg-destructive/[0.07] px-3.5 py-3 text-meta leading-[1.5] text-destructive"
        >
          This looks like {review.lookalike.slice(0, 6)}…{review.lookalike.slice(-4)}, an address
          you sent to before, but the middle is different. Scammers plant addresses like this. Check
          every character before you send.
        </p>
      ) : review.destination === "exchange" ? (
        <p className="mt-3 text-meta leading-[1.5] text-muted-foreground">
          Check that your exchange takes USDC on {network}. Money sent on a network it doesn’t
          support can be lost.
        </p>
      ) : null}

      <dl className="mt-4 divide-y divide-foreground/[0.06] text-ui">
        {[
          ["Network", network],
          ["Arrives", pinned.arrives],
          ["Fee", pinned.fee],
          ["SOL for fees", pinned.solForFees],
        ].map(([label, value]) =>
          value ? (
            <div key={label} className="flex items-center justify-between py-2">
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
          First time sending here, so Auni checks it&apos;s you.
        </ProofNote>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 text-meta text-destructive">
          {error}
        </p>
      ) : null}

      <div className="mt-5 grid grid-cols-2 gap-3">
        <Button
          className={auniDialogOutlineButtonClass}
          disabled={busy}
          onClick={onBack}
          type="button"
          variant="outline"
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
