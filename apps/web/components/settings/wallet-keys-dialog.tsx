"use client";

import { Check, Copy, Eye, EyeOff, LoaderCircle, X } from "lucide-react";
import { useEffect, useState } from "react";

import { mustPairAgain, PairAgain } from "@/components/auth/pair-again";
import { MoneySheet } from "@/components/money/money-sheet";
import {
  auniDialogDestructiveButtonClass,
  auniDialogOutlineButtonClass,
} from "@/components/ui/auni-dialog";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { revealWalletKeys } from "@/lib/data/me";
import { useClipboardCopy } from "@/lib/use-clipboard-copy";
import { cn } from "@/lib/utils";

type WalletKeys = Awaited<ReturnType<typeof revealWalletKeys>>;

/** How long a key shows once revealed before it's hidden again. */
const SHOWN_FOR_MS = 60_000;

/**
 * Hands over the wallet's keys, so the money is the owner's whatever happens to Auni. Core shows
 * them only to a request that proves the owner is there, so someone at a browser paired long ago,
 * say an unlocked laptop, can't read the keys off this button alone. Even then each key stays
 * hidden until it's asked for, and hides again a minute on. The keys live only in this sheet's
 * state, which goes when it closes; a tap outside doesn't close it by accident.
 */
export function WalletKeysDialog({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <MoneySheet held open={open} onOpenChange={onOpenChange}>
      <DialogClose asChild>
        <Button
          aria-label="Close"
          className="absolute top-5 right-5 z-10"
          size="icon-sm"
          variant="ghost"
        >
          <X aria-hidden />
        </Button>
      </DialogClose>
      <ShowKeys />
    </MoneySheet>
  );
}

const RISKS = [
  "Anyone with them can move everything in your wallet, with no card to tap and no way to undo it.",
  "Auni will never ask for them. Anyone who does isn't Auni.",
  "Your wallet keeps working here exactly as before.",
] as const;

/** The sheet's inside, drawn afresh each time it opens, so no key carries over. */
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
      else setError("Couldn't reach Auni. Nothing was shown. Try again.");
    } finally {
      setChecking(false);
    }
  };

  if (keys)
    return (
      <>
        <DialogTitle className="pr-10 text-title text-ink">Your keys</DialogTitle>
        <DialogDescription className="mt-1.5 text-body text-muted-foreground">
          Save them somewhere only you can reach, like a password manager. Revealed keys hide after
          60s.
        </DialogDescription>
        <WalletKeyList className="mt-6" keys={keys} />
        <DialogClose asChild>
          <Button className={cn(auniDialogOutlineButtonClass, "mt-6")} variant="secondary">
            Done
          </Button>
        </DialogClose>
      </>
    );
  return (
    <>
      <DialogTitle className="pr-10 text-title text-ink">Show your keys?</DialogTitle>
      <DialogDescription className="mt-1.5 text-body text-ink">
        Your wallet keys are the master key to your money.
      </DialogDescription>
      <ul className="mt-4 flex flex-col gap-2.5 text-ui text-muted-foreground">
        {RISKS.map((risk) => (
          <li key={risk} className="flex gap-3">
            <span aria-hidden className="mt-2 size-1.5 flex-none rounded-full bg-faint" />
            {risk}
          </li>
        ))}
      </ul>
      {pairAgain ? (
        <PairAgain className="mt-5" then="Then tap Show keys again." />
      ) : (
        <p className="mt-5 text-meta text-muted-foreground">Auni checks it&apos;s you first.</p>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-meta text-negative">
          {error}
        </p>
      ) : null}
      <div className="mt-6 grid grid-cols-2 gap-3">
        <DialogClose asChild>
          <Button className={auniDialogOutlineButtonClass} variant="secondary">
            Cancel
          </Button>
        </DialogClose>
        <Button
          className={auniDialogDestructiveButtonClass}
          disabled={checking}
          variant="destructive"
          onClick={() => void showKeys()}
        >
          {checking ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
          Show keys
        </Button>
      </div>
    </>
  );
}

/**
 * The keys, each hidden until its eye is pressed and hidden again a minute on, with Copy beside
 * it, which copies whether it shows or not: here, and in first run's backup step.
 */
export function WalletKeyList({
  keys,
  className,
}: {
  readonly keys: WalletKeys;
  readonly className?: string;
}) {
  const clipboard = useClipboardCopy();
  const [shown, setShown] = useState<string | null>(null);
  const [copiedOnce, setCopiedOnce] = useState(false);
  useEffect(() => {
    if (!shown) return;
    const hide = window.setTimeout(() => setShown(null), SHOWN_FOR_MS);
    return () => window.clearTimeout(hide);
  }, [shown]);
  const list = [
    { label: "Monad, Base and more", value: keys.evm },
    { label: "Solana", value: keys.solana },
  ].flatMap(({ label, value }) => (value ? [{ label, value }] : []));
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {list.map(({ label, value }) => {
        const on = shown === value;
        const copied = clipboard.copiedValue === value;
        return (
          <div key={label} className="rounded-card border border-border p-3 text-left">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-meta font-semibold text-ink">
                {label}
              </span>
              <Button
                aria-label={on ? `Hide the ${label} key` : `Show the ${label} key`}
                aria-pressed={on}
                onClick={() => setShown(on ? null : value)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                {on ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              </Button>
              <Button
                aria-label={copied ? "Copied" : `Copy the ${label} key`}
                onClick={() => {
                  clipboard.copy(value);
                  setCopiedOnce(true);
                }}
                size="sm"
                type="button"
                variant="secondary"
              >
                {copied ? <Check aria-hidden className="text-positive" /> : <Copy aria-hidden />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <p
              className={cn(
                "mt-2 font-mono text-meta break-all",
                on ? "text-ink select-all" : "text-faint select-none",
              )}
            >
              {/* Hidden, it's dots as long as the key, so nothing of it can be read or selected. */}
              {on ? value : "•".repeat(value.length)}
            </p>
          </div>
        );
      })}
      {clipboard.blocked ? (
        <p className="text-meta text-muted-foreground">
          Your browser blocked copying. Show a key, then select it to copy.
        </p>
      ) : copiedOnce ? (
        <p className="text-meta text-muted-foreground">
          Paste it into your password manager, then copy something else to clear your clipboard.
        </p>
      ) : null}
    </div>
  );
}
