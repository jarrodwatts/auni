"use client";

import "./settings-dialog.css";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useRefreshMe } from "@/components/personalization/use-me";
import { auniDialogOverlayClass } from "@/components/ui/auni-dialog";
import { Dialog, DialogContent, DialogTitle, focusDialogTitle } from "@/components/ui/dialog";
import type { SettingsSection } from "@/lib/app-links";
import { useMediaQuery } from "@/lib/use-viewport";
import { cn } from "@/lib/utils";

import { AiPane } from "./ai-pane";
import { DevicesPane } from "./devices-pane";
import { HealthPane } from "./health-pane";
import { JumpedTo, type Jump } from "./settings-layout";
import { SettingsSearch } from "./settings-nav";
import { paneOf, SETTINGS_PANES, type SettingsSearchItem } from "./settings-search";
import { WalletPane } from "./wallet-pane";
import { YouPane } from "./you-pane";

/** How long where a search landed flashes. */
const FLASH_MS = 2_400;

/** How Settings moves between its list and a pane: a step the browser's Back undoes, or not. */
export type SettingsStep = "push" | "replace" | "back";

const PANES: Record<SettingsSection, () => React.JSX.Element> = {
  you: YouPane,
  ai: AiPane,
  wallet: WalletPane,
  devices: DevicesPane,
  health: HealthPane,
};

/**
 * Settings: five panes in the owner's words. Where there's room, the list sits beside the open
 * pane, with a search over every setting above it. On a phone it fills the screen: the list
 * (and the search) first, then a pane with a way back to it. The address says which pane is
 * open (`?settings=you`), or that the list is (`?settings=open`), so a link opens either.
 */
export function SettingsDialog({
  open,
  section,
  onSectionChange,
  onOpenChange,
}: {
  readonly open: boolean;
  /** The pane open, or null for the list (where there's room, that shows the first pane). */
  readonly section: SettingsSection | null;
  readonly onSectionChange: (section: SettingsSection | null, step: SettingsStep) => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const wide = useMediaQuery("(min-width: 768px)");
  const refreshMe = useRefreshMe();
  const [jumped, setJumped] = useState<Jump | null>(null);
  const jumps = useRef(0);
  // A pane the phone's list opened is a step the back arrow takes back out.
  const steppedIn = useRef(false);
  const shown = section ?? (wide ? "you" : null);

  useEffect(() => {
    if (open) refreshMe();
  }, [open, refreshMe]);

  // Where a search landed flashes for a moment (the setting scrolls itself into view once drawn).
  useEffect(() => {
    if (!jumped?.lit) return undefined;
    const done = window.setTimeout(() => setJumped({ ...jumped, lit: false }), FLASH_MS);
    return () => window.clearTimeout(done);
  }, [jumped]);

  const go = (next: SettingsSection) => {
    setJumped(null);
    if (!wide && section === null) {
      steppedIn.current = true;
      onSectionChange(next, "push");
    } else onSectionChange(next, "replace");
  };
  const back = () => {
    setJumped(null);
    onSectionChange(null, steppedIn.current ? "back" : "replace");
    steppedIn.current = false;
  };
  const jump = (item: SettingsSearchItem) => {
    go(item.section);
    jumps.current += 1;
    setJumped({ n: jumps.current, target: item.target, lit: true });
  };
  const close = () => {
    setJumped(null);
    steppedIn.current = false;
    onOpenChange(false);
  };

  const Pane = shown ? PANES[shown] : null;
  const closeButton = (
    <button
      type="button"
      aria-label="Close settings"
      onClick={close}
      className="grid size-9 flex-none place-items-center rounded-control text-muted-foreground transition-colors focus-ring hover:bg-foreground/[0.06] hover:text-ink"
    >
      <X className="size-4" />
    </button>
  );
  const body = Pane ? (
    <div
      key={shown}
      className="auni-field-in mx-auto flex w-full max-w-[640px] flex-col gap-8 pb-10"
    >
      <JumpedTo.Provider value={jumped}>
        <Pane />
      </JumpedTo.Provider>
    </div>
  ) : null;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        className={cn(
          "flex gap-0 overflow-hidden bg-background p-0 sm:max-w-none",
          wide
            ? "h-[min(92dvh,780px)] w-[min(96vw,1000px)] max-w-none flex-row rounded-sheet"
            : "inset-0 h-dvh max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col rounded-none border-0 data-[state=open]:zoom-in-100",
        )}
        overlayClassName={auniDialogOverlayClass}
        showCloseButton={false}
        onOpenAutoFocus={focusDialogTitle}
        aria-describedby={undefined}
      >
        {wide ? (
          <>
            <aside className="flex w-[232px] flex-none flex-col border-r border-border bg-sidebar">
              <DialogTitle className="px-5 pt-5 pb-3 text-section text-ink">Settings</DialogTitle>
              <SettingsSearch onJump={jump}>
                <nav aria-label="Settings" className="flex flex-col gap-0.5 px-2.5">
                  {SETTINGS_PANES.map((pane) => {
                    const current = pane.id === shown;
                    return (
                      <button
                        key={pane.id}
                        type="button"
                        aria-current={current ? "page" : undefined}
                        onClick={() => go(pane.id)}
                        className={cn(
                          "flex h-9 items-center gap-2.5 rounded-control px-2.5 text-left text-ui transition-colors duration-150 focus-ring",
                          current
                            ? "bg-foreground/[0.07] font-medium text-ink"
                            : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-ink",
                        )}
                      >
                        <pane.icon
                          aria-hidden
                          className={cn("size-4 flex-none", current ? "text-ink" : "text-faint")}
                          strokeWidth={1.9}
                        />
                        {pane.label}
                      </button>
                    );
                  })}
                </nav>
              </SettingsSearch>
            </aside>
            <div className="flex min-w-0 flex-1 flex-col">
              <header className="relative flex-none px-8 pt-7 pb-2">
                <h2 className="mx-auto w-full max-w-[640px] text-title text-ink">
                  {shown ? paneOf(shown).label : null}
                </h2>
                <span className="absolute top-5 right-5">{closeButton}</span>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-4">{body}</div>
            </div>
          </>
        ) : shown === null ? (
          <>
            <header className="flex flex-none items-center justify-between gap-3 px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-1">
              <DialogTitle className="text-title text-ink">Settings</DialogTitle>
              {closeButton}
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <SettingsSearch onJump={jump} phone>
                <ul className="mx-4 overflow-hidden rounded-card border border-border bg-card">
                  {SETTINGS_PANES.map((pane) => (
                    <li key={pane.id} className="not-first:border-t not-first:border-border">
                      <button
                        type="button"
                        onClick={() => go(pane.id)}
                        className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left focus-ring-inset active:bg-foreground/[0.04]"
                      >
                        <span className="flex size-9 flex-none items-center justify-center rounded-control bg-surface text-ink-soft">
                          <pane.icon aria-hidden className="size-[18px]" strokeWidth={1.9} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-body font-medium text-ink">{pane.label}</span>
                          <span className="mt-0.5 block text-meta text-muted-foreground">
                            {pane.holds}
                          </span>
                        </span>
                        <ChevronRight aria-hidden className="size-4 flex-none text-faint" />
                      </button>
                    </li>
                  ))}
                </ul>
              </SettingsSearch>
            </div>
          </>
        ) : (
          <>
            <header className="flex flex-none items-center justify-between gap-3 border-b border-border px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-2">
              <button
                type="button"
                onClick={back}
                className="flex h-9 items-center gap-0.5 rounded-control pr-3 pl-1 text-ui font-medium text-ink focus-ring"
              >
                <ChevronLeft aria-hidden className="size-5" />
                Settings
              </button>
              {closeButton}
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 pt-5 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <DialogTitle className="mb-6 text-title text-ink">{paneOf(shown).label}</DialogTitle>
              {body}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
