"use client";

import { Dialog as DialogPrimitive } from "radix-ui";
import { usePathname } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { useMe } from "@/components/personalization/use-me";
import { WithdrawDialog } from "@/components/withdraw/withdraw-dialog";

import { SearchPanel } from "./search-panel";
import { rememberRecentPlace } from "./stored-state";

interface SearchContextValue {
  /** Opens the ⌘K palette. */
  readonly openSearch: () => void;
  /** Withdraw straight from search: its own popup once there's a wallet, otherwise Settings' wallet. */
  readonly withdraw: () => void;
}

const SearchContext = createContext<SearchContextValue>({
  openSearch: () => undefined,
  withdraw: () => undefined,
});

export function useSearch(): SearchContextValue {
  return useContext(SearchContext);
}

/** The places search offers again once they've been opened: Portfolio, Activity, a specialist, a chat, the social pages. */
const PLACE_PATH = /^\/app(?:\/activity|\/c\/[^/]+|\/chat\/[^/]+)?$/u;

/**
 * Search lives in one palette over everything, opened by ⌘K (Ctrl+K)
 * anywhere or the sidebar's glass. It remembers where the person goes so an
 * empty search can offer it back.
 */
export function SearchProvider({ children }: { readonly children: ReactNode }) {
  // Each opening is a fresh search, even one reopened while the last is still fading out.
  const [palette, setPalette] = useState({ open: false, session: 0 });
  const setOpen = useCallback(
    (open: boolean | ((was: boolean) => boolean)) =>
      setPalette((was) => {
        const next = typeof open === "function" ? open(was.open) : open;
        if (next === was.open) return was;
        return { open: next, session: next ? was.session + 1 : was.session };
      }),
    [],
  );
  const [withdrawing, setWithdrawing] = useState(false);
  const { wallets } = useMe();
  const { openSettings } = useAppDialogs();
  const pathname = usePathname();

  useEffect(() => {
    if (PLACE_PATH.test(pathname)) rememberRecentPlace(pathname);
  }, [pathname]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLocaleLowerCase() !== "k") return;
      event.preventDefault();
      setOpen((was) => !was);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  const withdraw = useCallback(() => {
    if (wallets?.evm) setWithdrawing(true);
    else openSettings("wallet");
  }, [openSettings, wallets?.evm]);
  const value = useMemo(() => ({ openSearch: () => setOpen(true), withdraw }), [setOpen, withdraw]);
  const close = useCallback(() => setOpen(false), [setOpen]);

  return (
    <SearchContext value={value}>
      {children}
      <DialogPrimitive.Root open={palette.open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          {/* A light shade, no blur: the place stays readable under a quick jump. */}
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-200 motion-reduce:animate-none" />
          <DialogPrimitive.Content
            aria-describedby={undefined}
            className="fixed top-[max(16px,14vh)] left-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 flex-col overflow-hidden rounded-card border border-foreground/[0.08] bg-popover shadow-[0_24px_64px_-12px_--alpha(var(--color-shade)/22%),0_2px_6px_--alpha(var(--color-shade)/4%)] outline-none ease-settle data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98] data-[state=closed]:duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98] data-[state=open]:slide-in-from-top-1 data-[state=open]:duration-[260ms] motion-reduce:animate-none"
          >
            <DialogPrimitive.Title className="sr-only">Search</DialogPrimitive.Title>
            <SearchPanel key={palette.session} variant="palette" onDone={close} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <WithdrawDialog open={withdrawing} onOpenChange={setWithdrawing} />
    </SearchContext>
  );
}
