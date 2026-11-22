"use client";

import { auniDialogCardClass, auniDialogOverlayClass } from "@/components/ui/auni-dialog";
import { Dialog, DialogContent, focusDialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

import { DepositPortal } from "./portal/deposit-portal";

/**
 * Money in: the Portal shows the account's addresses to send to from any other wallet. `asked`
 * is null while it's closed, and names what a card needs when one opened it.
 */
export function AddMoneyDialog({
  asked,
  onOpenChange,
}: {
  readonly asked: { readonly need: string | null } | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={asked !== null} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          auniDialogCardClass,
          "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-[420px]",
        )}
        overlayClassName={auniDialogOverlayClass}
        showCloseButton={false}
        onOpenAutoFocus={focusDialogTitle}
      >
        <DepositPortal need={asked?.need ?? null} />
      </DialogContent>
    </Dialog>
  );
}
