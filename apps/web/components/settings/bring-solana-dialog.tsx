"use client";

import { AlertDialog, AlertDialogContent, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PairAgain } from "@/components/auth/pair-again";
import { PrivateInput } from "@/components/private-input/private-input";
import { usePrivateField } from "@/components/private-input/use-private-field";
import { MoneyButton } from "@/components/cards/money/money-card-parts";
import {
  auniDialogCardClass,
  auniDialogOverlayClass,
  auniDialogTitleClass,
} from "@/components/ui/auni-dialog";
import { cn } from "@/lib/utils";

/**
 * Brings a Solana key the owner already holds in beside the wallet's EVM key, through its private
 * field (`field`). Core takes it only from a browser that proves the owner is there, which it
 * says before anything is pasted, then shows the address the key signs for before adding it.
 */
export function BringSolanaDialog({
  field,
  open,
  onOpenChange,
  onDone,
}: {
  readonly field: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDone: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className={cn(auniDialogCardClass, "max-w-[calc(100%-2rem)]")}
        overlayClassName={auniDialogOverlayClass}
      >
        <AlertDialogTitle className={cn(auniDialogTitleClass, "mb-5")}>
          Add a Solana key you hold
        </AlertDialogTitle>
        <Bring field={field} onCancel={() => onOpenChange(false)} onDone={onDone} />
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The dialog's inside, read afresh each time it opens, so nothing typed carries over. */
function Bring({
  field,
  onCancel,
  onDone,
}: {
  readonly field: string;
  readonly onCancel: () => void;
  readonly onDone: () => void;
}) {
  const loaded = usePrivateField(field);
  if (loaded.kind === "ready")
    return (
      <PrivateInput
        named
        field={loaded.field}
        words={{ check: "Check key", preview: "This key signs for", confirm: "Add to wallet" }}
        secondary={{ label: "Cancel", onClick: onCancel }}
        onDone={onDone}
      />
    );
  if (loaded.kind === "loading") return <div aria-hidden className="h-[124px]" />;
  return (
    <div className="flex flex-col gap-3">
      {loaded.kind === "pair_again" ? (
        <PairAgain then="Then paste your key here." />
      ) : (
        <p className="text-meta leading-[18px] text-muted-foreground">
          {loaded.kind === "gone"
            ? "This wallet can't take a Solana key now."
            : "That didn't reach Auni. Try again."}
        </p>
      )}
      <MoneyButton tone="quiet" onClick={onCancel}>
        Cancel
      </MoneyButton>
    </div>
  );
}
