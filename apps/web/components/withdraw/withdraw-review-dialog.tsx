"use client";

import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";

import { MoneySheet } from "@/components/money/money-sheet";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { readWithdrawal, type Withdrawal } from "@/lib/data/withdrawals";

import { WithdrawReview } from "./withdraw-review";

/** A withdrawal Auni proposed in chat, confirmed on the same step as one started in Withdraw. */
export function WithdrawReviewDialog({
  actionReference,
  open,
  onOpenChange,
  onSent,
}: {
  readonly actionReference: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSent: (action: Withdrawal["action"]) => void;
}) {
  const withdrawal = useQuery({
    queryKey: ["withdrawal", actionReference],
    queryFn: ({ signal }) => readWithdrawal(actionReference, signal),
    enabled: open,
  });

  return (
    <MoneySheet open={open} onOpenChange={onOpenChange}>
      <DialogTitle className="pr-10 text-title text-ink">Check before you send</DialogTitle>
      <DialogDescription className="mt-1.5 text-body text-muted-foreground">
        Money sent to the wrong address can&apos;t come back.
      </DialogDescription>
      {withdrawal.data ? (
        <WithdrawReview
          className="mt-6"
          withdrawal={withdrawal.data}
          // Closing leaves the card waiting in the chat, neither allowed nor declined.
          backLabel="Close"
          onBack={() => onOpenChange(false)}
          onSent={(action) => {
            onSent(action);
            onOpenChange(false);
          }}
        />
      ) : withdrawal.isError ? (
        <p role="alert" className="mt-6 text-meta text-negative">
          Couldn&apos;t load this withdrawal. Nothing was sent. Close and try again.
        </p>
      ) : (
        <LoaderCircle aria-hidden className="mx-auto mt-6 animate-spin text-muted-foreground" />
      )}
    </MoneySheet>
  );
}
