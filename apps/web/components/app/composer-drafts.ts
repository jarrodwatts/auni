"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import { consumeBootDraft } from "@/components/app/composer-boot-draft";

const draftStorageKey = (draftKey: string) => `auni:composer-draft:${draftKey}`;

/** Reads the tab-scoped copy of a draft. Storage being blocked reads as empty. */
function readStoredDraft(draftKey: string): string {
  try {
    return window.sessionStorage.getItem(draftStorageKey(draftKey)) ?? "";
  } catch {
    return "";
  }
}

function writeStoredDraft(draftKey: string, text: string): void {
  try {
    window.sessionStorage.setItem(draftStorageKey(draftKey), text);
  } catch {
    // Storage being full or blocked must never break typing.
  }
}

function clearStoredDraft(draftKey: string): void {
  try {
    window.sessionStorage.removeItem(draftStorageKey(draftKey));
  } catch {
    // Storage being full or blocked must never break sending.
  }
}

interface ComposerDraft {
  readonly message: string;
  readonly setMessage: Dispatch<SetStateAction<string>>;
  readonly clearForSend: () => void;
}

export function useComposerDraft({
  draftKey,
  initialMessage,
  interactive,
}: {
  readonly draftKey: string | undefined;
  readonly initialMessage: string;
  readonly interactive: boolean;
}): ComposerDraft {
  const [message, setMessage] = useState(initialMessage);
  const adoptedRef = useRef(false);

  useEffect(() => {
    if (!interactive || adoptedRef.current) return;
    adoptedRef.current = true;
    const draft = consumeBootDraft() || (draftKey ? readStoredDraft(draftKey) : "");
    // Adoption reads storage the composer cannot see during render, so the
    // handoff is a store subscription's first read, not a render cascade. It
    // happens once, at the moment the composer becomes real.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    if (draft) setMessage((current) => current || draft);
    // Reacting to later changes would overwrite what the person typed since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive]);

  useEffect(() => {
    if (!draftKey) return;
    if (message) writeStoredDraft(draftKey, message);
    // Never clear a stored draft the composer has not adopted yet, the
    // pre-adoption render always carries an empty message. Text the person
    // deleted themselves is gone from storage too, so a remount cannot bring
    // it back.
    else if (adoptedRef.current) clearStoredDraft(draftKey);
  }, [draftKey, message]);

  const clearForSend = useCallback(() => {
    // Marked adopted so a clear that lands before adoption cannot be undone by
    // it: words already sent are never handed back to the same composer.
    adoptedRef.current = true;
    setMessage("");
    if (draftKey) clearStoredDraft(draftKey);
  }, [draftKey]);

  return { clearForSend, message, setMessage };
}
