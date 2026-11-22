"use client";

import type { SpecialistRulesWire } from "@auni/shared";
import { Hand, Zap } from "lucide-react";
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

/* The pieces the manage dialogs share, drawn in the house style. */

/**
 * Scrolls between a fixed title and a fixed button row. On a phone it rises
 * from the bottom edge as a sheet, and rides above the keyboard while typing.
 */
const manageDialogCardClass =
  "flex flex-col overflow-hidden p-0 sm:max-w-[440px] sm:p-0 max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-h-[calc(100dvh-24px)] max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-t-[22px] max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:data-[state=closed]:zoom-out-100 max-sm:data-[state=closed]:slide-out-to-bottom max-sm:data-[state=open]:zoom-in-100 max-sm:data-[state=open]:slide-in-from-bottom motion-reduce:animate-none";

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
        <p role="alert" className="mb-3 text-center text-[13.5px] text-destructive">
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
  "block w-full rounded-[12px] border border-foreground/[0.09] bg-background px-3.5 py-2.5 text-[15px] leading-6 text-ink outline-none transition-colors placeholder:text-faint focus:border-foreground/[0.28]";

type ActMode = SpecialistRulesWire["actMode"];

const MODES: readonly { key: ActMode; label: string; icon: typeof Hand }[] = [
  { key: "ask_first", label: "Ask first", icon: Hand },
  { key: "within_limits", label: "Act on its own", icon: Zap },
];

/**
 * What each mode means, in the words the dialog and the composer chip both
 * use. Kept the same length, so both wrap to the same lines.
 */
export const ACT_MODE_DETAIL: Readonly<Record<ActMode, string>> = {
  ask_first: "Auni suggests each move and waits for your tap. Nothing moves without you.",
  within_limits:
    "Auni buys with its unspent money, and sells, on its own. Anything else waits for your tap.",
};

export function ModeSwitch({
  mode,
  onChange,
}: {
  readonly mode: ActMode;
  readonly onChange: (mode: ActMode) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="How Auni acts"
      className="grid grid-cols-2 gap-1 rounded-[12px] bg-foreground/[0.045] p-1"
    >
      {MODES.map(({ key, label, icon: Icon }) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={mode === key}
          onClick={() => onChange(key)}
          className={cn(
            "flex h-9 items-center justify-center gap-1.5 rounded-[9px] text-[13.5px] font-medium whitespace-nowrap transition-colors",
            mode === key
              ? "bg-background text-ink shadow-[0_0_0_1px_--alpha(var(--color-shade)/6%),0_1px_2px_--alpha(var(--color-shade)/6%)]"
              : "text-muted-foreground hover:text-ink",
          )}
        >
          <Icon aria-hidden className="size-3.5" strokeWidth={2.1} />
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * The chosen mode in words. Both lines share one grid cell and crossfade,
 * so the taller one always holds the space and nothing below ever moves.
 */
export function ModeDetail({ mode }: { readonly mode: ActMode }) {
  return (
    <div className="grid" aria-live="polite">
      {MODES.map(({ key }) => (
        <p
          key={key}
          aria-hidden={key !== mode}
          className={cn(
            "col-start-1 row-start-1 text-[13px] leading-[1.5] text-muted-foreground transition-opacity duration-200 ease-settle motion-reduce:transition-none",
            key === mode ? "opacity-100" : "opacity-0",
          )}
        >
          {ACT_MODE_DETAIL[key]}
        </p>
      ))}
    </div>
  );
}
