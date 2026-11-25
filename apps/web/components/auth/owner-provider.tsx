"use client";

import type { Me } from "@auni/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { CoreApiError } from "@/lib/core";
import { handedOverTo } from "@/lib/data/handover";
import { getMe } from "@/lib/data/me";
import { pairBrowser, refusedAs, whyUnreachable } from "@/lib/data/owner";
import { pairingCodeIn } from "@/lib/pairing";

/**
 * Who this browser is to Auni. One owner, no accounts: a browser either holds the owner's session
 * cookie or it doesn't, and core answers GET /me only when it does. The cookie comes from the
 * link `auni` opens (or `auni pair` prints), `/app#pair=<code>`, which this spends on the way in,
 * so the browser lands in the app already signed in.
 */
export type OwnerState =
  | { readonly status: "loading" }
  | { readonly status: "paired"; readonly owner: Me }
  /** No session, and no link brought one. */
  | { readonly status: "unpaired" }
  /** Always on: core opens only to its owner's Tailscale login, and this request wasn't that. */
  | { readonly status: "tailscale-only" }
  /** The link's code was refused: used already, or past its 15 minutes. */
  | { readonly status: "link-used" }
  /** No core answers yet; read again every few seconds. */
  | { readonly status: "starting" }
  /** Core answers but can't reach its database. */
  | { readonly status: "database" }
  /** This Auni was handed over to another machine, and runs there now. */
  | { readonly status: "handed-over"; readonly to: string; readonly machine: string };

interface OwnerContextValue {
  readonly state: OwnerState;
  /** Keeps the owner as core said them now, after a change such as finishing first run. */
  readonly setOwner: (owner: Me) => void;
  /** This page spent a pairing link as it opened, so the browser paired seconds ago. */
  readonly pairedHere: boolean;
}

const OwnerContext = createContext<OwnerContextValue | null>(null);

/**
 * While the app can't open, it's read again this often, so the page carries on by itself: once
 * Auni is up or its database back, or once the owner paired this browser from another tab.
 */
const AGAIN_MS = { starting: 2_000, database: 3_000, unpaired: 3_000, "link-used": 3_000 } as const;

type Spent = "none" | "spent" | "refused" | "failed";

async function spend(code: string): Promise<Spent> {
  try {
    await pairBrowser(code);
    return "spent";
  } catch (error) {
    // 403 is core's one answer for a code that is wrong, spent or old; anything else never got there.
    return error instanceof CoreApiError && error.status === 403 ? "refused" : "failed";
  }
}

export function OwnerProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<OwnerState>({ status: "loading" });
  const [reads, setReads] = useState(0);
  const [pairedHere, setPairedHere] = useState(false);
  // The link's code, taken off the address once; and its one spend, which Strict Mode's second
  // run of the effect shares rather than spending the code twice (and finding it used).
  const linkCode = useRef<string | null | undefined>(undefined);
  const spending = useRef<Promise<Spent> | null>(null);

  useEffect(() => {
    let current = true;
    if (linkCode.current === undefined) {
      linkCode.current = pairingCodeIn(window.location.hash);
      // Off the address bar and out of history, so the code isn't left lying about.
      if (linkCode.current)
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    const code = linkCode.current;
    spending.current ??= code ? spend(code) : Promise.resolve("none");
    void (async () => {
      const spent = await spending.current!;
      // A spend that never reached core tries the same code again on the next read.
      if (spent === "failed") spending.current = null;
      try {
        const owner = await getMe();
        if (!current) return;
        if (spent === "spent") setPairedHere(true);
        setState({ status: "paired", owner });
      } catch (error) {
        if (!current) return;
        const refused = refusedAs(error, spent === "refused");
        if (refused) return setState({ status: refused });
        if (error instanceof CoreApiError && error.code === "handed_over") {
          const went = await handedOverTo();
          if (current && went)
            return setState({ status: "handed-over", to: went.to, machine: went.machine });
        }
        const why = await whyUnreachable();
        if (current) setState({ status: why });
      }
    })();
    return () => {
      current = false;
    };
  }, [reads]);

  const waitsOn = state.status in AGAIN_MS ? (state.status as keyof typeof AGAIN_MS) : null;
  useEffect(() => {
    if (!waitsOn) return undefined;
    const readAgain = () => setReads((count) => count + 1);
    const again = setTimeout(readAgain, AGAIN_MS[waitsOn]);
    // Back from the terminal or the tab the link opened: read now rather than in a moment.
    window.addEventListener("focus", readAgain);
    return () => {
      clearTimeout(again);
      window.removeEventListener("focus", readAgain);
    };
  }, [waitsOn, state]);

  // A link pasted into a tab already open here changes only the fragment, which loads nothing.
  useEffect(() => {
    const pasted = () => {
      if (!pairingCodeIn(window.location.hash)) return;
      linkCode.current = undefined;
      spending.current = null;
      setState({ status: "loading" });
      setReads((count) => count + 1);
    };
    window.addEventListener("hashchange", pasted);
    return () => window.removeEventListener("hashchange", pasted);
  }, []);

  const setOwner = useCallback((owner: Me) => setState({ status: "paired", owner }), []);
  const value = useMemo(() => ({ state, setOwner, pairedHere }), [state, setOwner, pairedHere]);
  return <OwnerContext value={value}>{children}</OwnerContext>;
}

export function useOwner(): OwnerContextValue {
  const value = useContext(OwnerContext);
  if (!value) throw new Error("useOwner must be used inside OwnerProvider");
  return value;
}
