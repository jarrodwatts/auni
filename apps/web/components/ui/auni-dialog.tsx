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
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const auniDialogOverlayClass = "bg-veil backdrop-blur-[2px]";

export const auniDialogCardClass =
  "gap-0 rounded-sheet border-border bg-popover p-6 shadow-float sm:max-w-[400px] sm:p-6";

export const auniDialogTitleClass = "text-section text-ink";

export const auniDialogDescriptionClass = "mt-2.5 text-body leading-[1.5] text-muted-foreground";

export const auniDialogPrimaryButtonClass = buttonVariants({
  variant: "primary",
  size: "lg",
  className: "w-full",
});

export const auniDialogDestructiveButtonClass = buttonVariants({
  variant: "destructive",
  size: "lg",
  className: "w-full",
});

export const auniDialogOutlineButtonClass = buttonVariants({
  variant: "secondary",
  size: "lg",
  className: "w-full",
});

/**
 * The mascot leads a popup where Auni itself waits on the owner (a withdrawal, a report). The
 * generic ones below go without it: a confirm or a notice is chrome, and the mascot is never that.
 */
export function AuniDialogMascot({ state }: { readonly state: MascotState }) {
  return (
    <div className="mx-auto mt-1 w-fit">
      <Mascot className="auni-onb-mascot" size={56} state={state} />
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
        <AlertDialogHeader className="gap-0 sm:place-items-center sm:text-center">
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
        <AlertDialogHeader className="gap-0 sm:place-items-center sm:text-center">
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
