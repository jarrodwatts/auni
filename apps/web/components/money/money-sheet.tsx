"use client";

import type { ReactNode } from "react";

import { auniDialogCardClass, auniDialogOverlayClass } from "@/components/ui/auni-dialog";
import { Dialog, DialogContent, focusDialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Where money comes in and goes out (Add money, Withdraw, the wallet's keys): a sheet in the middle
 * of the screen on a computer, and from the bottom edge, full width, on a phone, where the thumb
 * is. Focus starts on its title, so a screen reader hears what it is, never a phone keyboard by
 * accident. `held` keeps a tap outside from closing it, for a step that shouldn't vanish on a
 * stray tap (the keys).
 */
export function MoneySheet({
  open,
  onOpenChange,
  held = false,
  className,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly held?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(auniDialogCardClass, SHEET, className)}
        overlayClassName={auniDialogOverlayClass}
        showCloseButton={false}
        onOpenAutoFocus={focusDialogTitle}
        onInteractOutside={held ? (event) => event.preventDefault() : undefined}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** Centred and 420 wide from the `sm` width; below it, a sheet up from the bottom edge. */
const SHEET = [
  "max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain sm:max-w-[420px]",
  "max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0",
  "max-sm:max-h-[calc(100dvh-max(24px,env(safe-area-inset-top)))] max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0",
  "max-sm:pb-[max(24px,env(safe-area-inset-bottom))]",
  "max-sm:data-[state=open]:slide-in-from-bottom max-sm:data-[state=closed]:slide-out-to-bottom",
  "max-sm:data-[state=open]:zoom-in-100 max-sm:data-[state=closed]:zoom-out-100",
].join(" ");
