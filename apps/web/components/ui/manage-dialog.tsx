"use client";

import type { ComponentProps } from "react";

import { useKeyboardInset, useMediaQuery } from "@/lib/use-viewport";
import {
  auniDialogCardClass,
  auniDialogOutlineButtonClass,
  auniDialogOverlayClass,
  auniDialogPrimaryButtonClass,
} from "@/components/ui/auni-dialog";
import { DialogContent } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Scrolls between a fixed title and a fixed button row. On a phone it rises
 * from the bottom edge as a sheet, and rides above the keyboard while typing.
 */
const manageDialogCardClass =
  "flex flex-col overflow-hidden p-0 sm:max-w-[440px] sm:p-0 max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-h-[calc(100dvh-24px)] max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-t-sheet max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:data-[state=closed]:zoom-out-100 max-sm:data-[state=closed]:slide-out-to-bottom max-sm:data-[state=open]:zoom-in-100 max-sm:data-[state=open]:slide-in-from-bottom motion-reduce:animate-none";

export function ManageDialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof DialogContent>) {
  const phone = useMediaQuery("(max-width: 639px)");
  const keyboard = useKeyboardInset(phone);
  return (
    <DialogContent
      showCloseButton={false}
      overlayClassName={auniDialogOverlayClass}
      className={cn(auniDialogCardClass, manageDialogCardClass, className)}
      style={
        keyboard.visible === null
          ? undefined
          : { bottom: keyboard.inset, maxHeight: keyboard.visible - 12 }
      }
      {...props}
    >
      {children}
    </DialogContent>
  );
}

/**
 * Cancel and Save, over the error line when a save failed. The row's floor
 * keeps clear of the home indicator on a phone. Without `onSave`, Save
 * submits the form it sits in.
 */
export function ManageFooter({
  failed,
  pending,
  canSave,
  onCancel,
  onSave,
  className,
}: {
  readonly failed: boolean;
  readonly pending: boolean;
  readonly canSave: boolean;
  readonly onCancel: () => void;
  readonly onSave?: () => void;
  readonly className?: string;
}) {
  return (
    <div
      className={cn("px-6 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pb-6", className)}
    >
      {failed ? (
        <p role="alert" className="mb-3 text-center text-ui text-destructive">
          Couldn’t save. Try again.
        </p>
      ) : null}
      <div className="grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className={cn(auniDialogOutlineButtonClass, "border text-ink hover:bg-foreground/[0.03]")}
        >
          Cancel
        </button>
        <button
          type={onSave ? "button" : "submit"}
          onClick={onSave}
          disabled={pending || !canSave}
          className={cn(auniDialogPrimaryButtonClass, "disabled:opacity-40")}
        >
          Save
        </button>
      </div>
    </div>
  );
}

export const manageFieldClass =
  "block w-full rounded-control border border-foreground/[0.09] bg-background px-3.5 py-2.5 text-body leading-6 text-ink outline-none transition-colors placeholder:text-faint focus:border-foreground/[0.28]";
