"use client";

import { splitKeys, type PrivateCheckWire, type PrivateFieldWire } from "@auni/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useRefreshMe } from "@/components/personalization/use-me";
import { SecretInput, SecretNote, secretRefusal } from "@/components/private-input/secret-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle, focusDialogTitle } from "@/components/ui/dialog";
import { ManageDialogContent } from "@/components/ui/manage-dialog";
import { acceptPrivate, checkPrivate } from "@/lib/data/private";

import { NotLooking } from "./not-looking";

/** How long after the last change what's pasted is checked. */
const CHECK_AFTER_MS = 250;

/**
 * For an owner who already has a wallet: its keys, into the wallet's private field, with Auni's
 * back turned while they paste. Only before the first take, while there is no wallet yet (core
 * offers the field only then); after it, Auni has made them one.
 */
export function BringWallet({
  field,
  open,
  onOpenChange,
}: {
  readonly field: PrivateFieldWire;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [typing, setTyping] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <ManageDialogContent onOpenAutoFocus={focusDialogTitle} className="px-5 pt-6 pb-5 sm:px-7">
        <NotLooking away={typing} size={88} className="mx-auto" />
        <DialogTitle className="mt-3 text-center text-ink">
          Bring an existing wallet
        </DialogTitle>
        <DialogDescription className="mt-1.5 text-center text-pretty">
          Paste a private key: a Monad, Base, or Ethereum key (0x…), a Solana key, or both.
        </DialogDescription>
        <div
          className="mt-5"
          onFocusCapture={() => setTyping(true)}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTyping(false);
          }}
        >
          <BringKeys field={field} onDone={() => onOpenChange(false)} />
        </div>
      </ManageDialogContent>
    </Dialog>
  );
}

/**
 * The wallet's private field: one place to paste, read as it lands, with the addresses the keys
 * sign for, then one button. A whole EVM key with no Solana one may add a Solana key on its own.
 * What's pasted lives here alone and goes only to core's `/private/:id`.
 */
function BringKeys({
  field,
  onDone,
}: {
  readonly field: PrivateFieldWire;
  readonly onDone: () => void;
}) {
  const refreshMe = useRefreshMe();
  const queryClient = useQueryClient();
  const [keys, setKeys] = useState("");
  const [solana, setSolana] = useState("");
  const [check, setCheck] = useState<{ readonly of: string; readonly said: PrivateCheckWire }>();
  const [error, setError] = useState<string | null>(null);
  const [bringing, setBringing] = useState(false);
  const [addingSolana, setAddingSolana] = useState(false);
  const solanaToo = lacksSolana(keys);
  const typed = `${keys}\n${solana}`;
  const checked = check?.of === typed ? check.said : null;

  useEffect(() => {
    if (!keys.trim()) return undefined;
    let current = true;
    const reading = setTimeout(() => {
      checkPrivate(field.id, bringValues(keys, solana)).then(
        (said) => current && setCheck({ of: `${keys}\n${solana}`, said }),
        (refused: unknown) => current && setError(secretRefusal(refused)),
      );
    }, CHECK_AFTER_MS);
    return () => {
      current = false;
      clearTimeout(reading);
    };
  }, [field.id, keys, solana]);

  const bring = async () => {
    if (!checked || bringing) return;
    setBringing(true);
    try {
      await acceptPrivate(field.id, bringValues(keys, solana));
      setKeys("");
      setSolana("");
      refreshMe();
      void queryClient.invalidateQueries({ queryKey: ["setup"] });
      // What was read before these keys came in says nothing of what they hold.
      void queryClient.resetQueries({ queryKey: ["portfolio"] });
      onDone();
    } catch (refused) {
      setError(secretRefusal(refused));
      setBringing(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <SecretInput
        label="Your private key"
        labelHidden
        value={keys}
        placeholder="Paste your private key"
        disabled={bringing}
        onChange={(value) => {
          setKeys(value);
          setError(null);
        }}
        onEnter={() => void bring()}
      />
      {solanaToo && addingSolana ? (
        <SecretInput
          label="Your Solana key"
          value={solana}
          placeholder="Paste your Solana private key"
          disabled={bringing}
          onChange={(value) => {
            setSolana(value);
            setError(null);
          }}
          onEnter={() => void bring()}
        />
      ) : null}
      {error ? (
        <p role="alert" className="text-meta text-destructive">
          {error}
        </p>
      ) : checked ? (
        <div aria-live="polite" className="text-meta">
          <p className="text-ink-soft">
            Signs for{" "}
            <span className="font-mono text-caption break-all text-ink">{checked.preview}</span>
          </p>
          {checked.notes.map((note) => (
            <p key={note} className="mt-1 text-muted-foreground">
              {note}
            </p>
          ))}
          {solanaToo && !addingSolana ? (
            <button
              type="button"
              className="mt-1.5 font-medium text-primary underline decoration-primary/35 underline-offset-[3px] hover:decoration-current"
              onClick={() => setAddingSolana(true)}
            >
              Add a Solana key too
            </button>
          ) : null}
        </div>
      ) : (
        <SecretNote says={field.goes} />
      )}
      <Button
        size="lg"
        className="w-full"
        disabled={!checked || bringing}
        aria-busy={bringing}
        onClick={() => void bring()}
      >
        {bringing ? "Saving wallet" : "Use this wallet"}
      </Button>
    </div>
  );
}

/** Whether what was pasted is a whole EVM key and no Solana one, which may then come on its own. */
function lacksSolana(keys: string): boolean {
  const pasted = splitKeys(keys);
  return pasted.solana.length === 0 && pasted.evm.some((key) => /^(0x)?[0-9a-f]{64}$/iu.test(key));
}

/** What goes to the field: what was pasted, and a Solana key on its own only where that lacks one. */
function bringValues(keys: string, solana: string): Record<string, string> {
  return lacksSolana(keys) && solana.trim() ? { keys, solana } : { keys };
}
