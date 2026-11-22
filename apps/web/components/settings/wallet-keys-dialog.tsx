"use client";

import { Check, Copy, LoaderCircle } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  AuniDialogMascot,
  auniDialogCardClass,
  auniDialogDescriptionClass,
  auniDialogDestructiveButtonClass,
  auniDialogOutlineButtonClass,
  auniDialogOverlayClass,
  auniDialogTitleClass,
} from "@/components/ui/auni-dialog";
import { revealWalletKeys } from "@/lib/data/me";
import { mustPairAgain, PairAgain } from "@/components/auth/pair-again";
import { useClipboardCopy } from "@/lib/use-clipboard-copy";
import { cn } from "@/lib/utils";

type WalletKeys = Awaited<ReturnType<typeof revealWalletKeys>>;

/**
 * Hands over the wallet's keys, so the money is the owner's whatever happens to Auni. Core shows
 * them only to a request that proves the owner is there, so someone at a browser paired long ago,
 * say an unlocked laptop, can't read the keys off this button alone. The keys live only in this
 * dialog's state, which goes when it closes.
 */
export function WalletKeysDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent
        className={cn(auniDialogCardClass, "max-w-[calc(100%-2rem)]")}
        overlayClassName={auniDialogOverlayClass}
      >
        <ShowKeys />
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** The dialog's inside, drawn afresh each time it opens, so no key carries over. */
function ShowKeys() {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairAgain, setPairAgain] = useState(false);
  const [keys, setKeys] = useState<WalletKeys | null>(null);

  const showKeys = async () => {
    setChecking(true);
    setError(null);
    setPairAgain(false);
    try {
      setKeys(await revealWalletKeys());
    } catch (caught) {
      if (mustPairAgain(caught)) setPairAgain(true);
      else setError("That didn't reach Auni. Nothing was shown, so try again.");
    } finally {
      setChecking(false);
    }
  };

  if (keys) return <ShownKeys keys={keys} />;
  return (
    <>
      <AuniDialogMascot state="listening" />
      <AlertDialogHeader className="mt-4 gap-0">
        <AlertDialogTitle className={auniDialogTitleClass}>Show your keys?</AlertDialogTitle>
        <AlertDialogDescription asChild>
          <div className={cn(auniDialogDescriptionClass, "space-y-2.5 text-left")}>
            <p>
              A wallet key is the master password for your money. Anyone who gets it can take
              everything in that wallet right away: no approval, no waiting period, and no way to
              undo it.
            </p>
            <p>
              None of Auni’s protections follow the key. Auni will never ask you for it, and anyone
              who does is not from Auni.
            </p>
            <p>
              Your wallet keeps working here exactly as before. Showing the keys does not switch
              anything off.
            </p>
          </div>
        </AlertDialogDescription>
      </AlertDialogHeader>
      {pairAgain ? (
        <PairAgain className="mt-4" then="Then show your keys here again." />
      ) : (
        <p className="mt-3 text-left text-[13px] leading-[1.5] text-muted-foreground">
          Auni checks it’s you before they show.
        </p>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-7 grid grid-cols-2 gap-3">
        <AlertDialogCancel className={auniDialogOutlineButtonClass}>Cancel</AlertDialogCancel>
        <AlertDialogAction
          className={auniDialogDestructiveButtonClass}
          disabled={checking}
          variant="destructive"
          onClick={(event) => {
            event.preventDefault();
            void showKeys();
          }}
        >
          {checking ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
          Show my keys
        </AlertDialogAction>
      </div>
    </>
  );
}

/** Each key the wallet holds, with a button that copies it. */
function ShownKeys({ keys }: { readonly keys: WalletKeys }) {
  return (
    <>
      <AlertDialogHeader className="gap-0">
        <AlertDialogTitle className={auniDialogTitleClass}>Your keys</AlertDialogTitle>
        <AlertDialogDescription className={cn(auniDialogDescriptionClass, "text-left")}>
          Keep them somewhere only you can reach. They go from this screen when you close it.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <WalletKeyList className="mt-5" keys={keys} />
      <div className="mt-7">
        <AlertDialogCancel className={cn(auniDialogOutlineButtonClass, "w-full")}>
          Done
        </AlertDialogCancel>
      </div>
    </>
  );
}

/** The keys, each with a button that copies it: here, and in first run's backup step. */
export function WalletKeyList({
  keys,
  className,
}: {
  readonly keys: WalletKeys;
  readonly className?: string;
}) {
  const clipboard = useClipboardCopy();
  const shown = [
    { label: "EVM key (every EVM network)", value: keys.evm },
    { label: "Solana key", value: keys.solana },
  ].flatMap(({ label, value }) => (value ? [{ label, value }] : []));
  return (
    <div className={cn("space-y-3", className)}>
      {shown.map(({ label, value }) => (
        <div key={label} className="rounded-[14px] border border-foreground/[0.1] p-3 text-left">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[12.5px] font-semibold text-ink">{label}</span>
            <button
              type="button"
              onClick={() => clipboard.copy(value)}
              className="flex items-center gap-1.5 rounded-full px-2 py-1 text-[12.5px] text-muted-foreground transition-colors hover:bg-foreground/[0.05]"
            >
              {clipboard.copiedValue === value ? (
                <Check aria-hidden className="size-3.5" />
              ) : (
                <Copy aria-hidden className="size-3.5" />
              )}
              {clipboard.copiedValue === value ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-2 font-mono text-[12px] break-all text-ink select-all">{value}</p>
        </div>
      ))}
      {clipboard.blocked ? (
        <p className="text-[12.5px] text-muted-foreground">
          This browser blocked copying: select a key to copy it by hand.
        </p>
      ) : null}
    </div>
  );
}
