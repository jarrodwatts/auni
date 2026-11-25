"use client";

import { useQuery } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";

import {
  AuniDialogMascot,
  auniDialogCardClass,
  auniDialogDescriptionClass,
  auniDialogOverlayClass,
  auniDialogTitleClass,
} from "@/components/ui/auni-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { readWithdrawal, type Withdrawal } from "@/lib/data/withdrawals";
import { cn } from "@/lib/utils";

import { WithdrawReview } from "./withdraw-review";

/** A withdrawal Auni proposed in chat, confirmed on the same step as one started from Settings. */
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(auniDialogCardClass, "max-h-[calc(100dvh-2rem)] overflow-y-auto")}
        overlayClassName={auniDialogOverlayClass}
      >
        <AuniDialogMascot state="listening" />
        <DialogHeader className="mt-3.5 items-center gap-0 text-center sm:text-center">
          <DialogTitle className={auniDialogTitleClass}>Check before it goes</DialogTitle>
          <DialogDescription className={auniDialogDescriptionClass}>
            Money sent to a wrong address can’t come back.
          </DialogDescription>
        </DialogHeader>
        <div className="mt-5">
          {withdrawal.data ? (
            <WithdrawReview
              withdrawal={withdrawal.data}
              backLabel="Not now"
              onBack={() => onOpenChange(false)}
              onSent={(action) => {
                onSent(action);
                onOpenChange(false);
              }}
            />
          ) : withdrawal.isError ? (
            <p role="alert" className="text-center text-meta text-destructive">
              This withdrawal couldn’t load. Nothing was sent.
            </p>
          ) : (
            <LoaderCircle aria-hidden className="mx-auto animate-spin text-muted-foreground" />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
