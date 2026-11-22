import type { RefObject } from "react";

import { Mascot, type MascotState } from "@/components/brand/mascot";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

export const auniDialogOverlayClass = "bg-veil backdrop-blur-[2px]";

export const auniDialogCardClass =
  "gap-0 rounded-[20px] border-foreground/[0.12] bg-popover p-6 shadow-[0_18px_60px_--alpha(var(--color-shade)/16%)] sm:max-w-[400px] sm:p-6";

export const auniDialogTitleClass =
  "text-[20px] leading-7 font-semibold tracking-[-0.025em] text-ink";

export const auniDialogDescriptionClass = "mt-2.5 text-[15px] leading-[1.5] text-muted-foreground";

export const auniDialogPrimaryButtonClass =
  "h-11 w-full rounded-full bg-foreground text-[14px] font-semibold text-background hover:bg-foreground/85";

/** Refined rose destructive, the same as the logout row: --destructive. */
export const auniDialogDestructiveButtonClass =
  "h-11 w-full rounded-full bg-destructive text-[14px] font-semibold text-background hover:bg-destructive/90";

export const auniDialogOutlineButtonClass =
  "h-11 w-full rounded-full border-foreground/[0.14] text-[14px] font-medium";

/** The mascot leads every popup, glowing and popping in like onboarding. */
export function AuniDialogMascot({ state }: { readonly state: MascotState }) {
  return (
    <div className="relative mx-auto mt-1 w-fit">
      <span
        aria-hidden
        className="absolute -inset-3 -z-10 rounded-[32px] bg-[radial-gradient(circle,--alpha(var(--color-halo)/18%),transparent_70%)]"
      />
      <Mascot className="auni-onb-mascot" size={64} state={state} />
    </div>
  );
}

/**
 * Asks before something that's hard to take back. Cancel takes focus, so a stray Enter keeps
 * things as they are. It opens from state, not a Radix trigger, so a dialog opened by a button
 * that stays on screen passes that button as `returnFocus`: else a keyboard user who cancels
 * loses their place. Without one, focus goes where the dialog would send it.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  verb,
  returnFocus,
  onConfirm,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly body: string;
  /** The destructive button's word, such as "Archive". */
  readonly verb: string;
  readonly returnFocus?: RefObject<HTMLElement | null>;
  readonly onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className={cn(auniDialogCardClass, "max-w-[calc(100%-2rem)]")}
        overlayClassName={auniDialogOverlayClass}
        onCloseAutoFocus={(event) => {
          if (!returnFocus) return;
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <AuniDialogMascot state="listening" />
        <AlertDialogHeader className="mt-4 gap-0 sm:place-items-center sm:text-center">
          <AlertDialogTitle className={cn(auniDialogTitleClass, "line-clamp-2 break-words")}>
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription className={auniDialogDescriptionClass}>
            {body}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="mt-7 grid grid-cols-2 gap-3">
          <AlertDialogCancel className={auniDialogOutlineButtonClass}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            className={auniDialogDestructiveButtonClass}
            onClick={onConfirm}
          >
            {verb}
          </AlertDialogAction>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Says why something the person asked for can't happen yet, in a calm sentence, with one button
 * to close it: a refusal they should read, not a toast that slips away.
 */
export function NoticeDialog({
  open,
  onOpenChange,
  title,
  body,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly body: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className={cn(auniDialogCardClass, "max-w-[calc(100%-2rem)]")}
        overlayClassName={auniDialogOverlayClass}
      >
        <AuniDialogMascot state="sad" />
        <AlertDialogHeader className="mt-4 gap-0 sm:place-items-center sm:text-center">
          <AlertDialogTitle className={cn(auniDialogTitleClass, "line-clamp-2 break-words")}>
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription className={auniDialogDescriptionClass}>
            {body}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogAction className={cn(auniDialogPrimaryButtonClass, "mt-7")}>
          Got it
        </AlertDialogAction>
      </AlertDialogContent>
    </AlertDialog>
  );
}
