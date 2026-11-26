"use client";

import { useCallback, useMemo, useState, type ReactNode } from "react";

import { ConversationLaunchStage } from "@/components/app/conversation-launch-stage";
import { useFirstRun } from "@/components/first-run/use-first-run";
import { CloseMobileThreadMenuContext } from "@/components/app/mobile-thread-menu";
import { useLiveThreadRows, useThreads } from "@/components/app/use-threads";
import { AuniSheet } from "@/components/ui/auni-sheet";
import { useMediaQuery } from "@/lib/use-viewport";
import { cn } from "@/lib/utils";

import { ArrivingContext } from "./arriving";
import { PlaceLayoutContext } from "./place-header";
import { SearchProvider } from "./search-palette";
import { Sidebar } from "./sidebar";
import { useStoredFlag } from "./stored-state";
import { MoreSheet, TabBar } from "./tab-bar";
import { ThreadInspectorPane } from "./thread-inspector-pane";
import { usePlaceRoute } from "./use-places";

/**
 * Three panes on a wide screen: the sidebar on the left, the place down the middle, and a take's
 * inspector on the right. On a phone, one place at a time over a tab bar.
 */
export function PlaceWorkspace({ children }: { readonly children: ReactNode }) {
  useLiveThreadRows();
  return (
    <SearchProvider>
      <PlaceShell>
        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          {children}
          <ConversationLaunchStage />
        </div>
      </PlaceShell>
    </SearchProvider>
  );
}

function PlaceShell({ children }: { readonly children: ReactNode }) {
  const route = usePlaceRoute();
  const firstRun = useFirstRun();
  const [wasFirstRun, setWasFirstRun] = useState(firstRun);
  const [arriving, setArriving] = useState(false);
  if (wasFirstRun !== firstRun) {
    setWasFirstRun(firstRun);
    setArriving(!firstRun);
  }
  const [railed, setRailed] = useStoredFlag("auni:sidebar-rail", false);
  const [paneOpen, setPaneOpen] = useStoredFlag("auni:thread-pane", false);
  const wide = useMediaQuery("(min-width: 1280px)");
  const roomy = useMediaQuery("(min-width: 1024px)");
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const place = route.kind === "chat" ? route.id : route.kind;
  const sheetOpen = sheetFor === place && !wide;
  const showPane = useCallback(() => {
    if (wide) setPaneOpen(true);
    else setSheetFor(place);
  }, [place, setPaneOpen, wide]);
  const layout = useMemo(
    () => ({ paneOpen, setPaneOpen, showPane }),
    [paneOpen, setPaneOpen, showPane],
  );
  const { threads } = useThreads();
  const activeThread =
    route.kind === "chat" ? threads.find(({ id }) => id === route.id) : undefined;
  const pane = route.kind === "chat" ? <ThreadInspectorPane threadId={route.id} /> : null;
  const paneShown = paneOpen && activeThread !== undefined;
  const paneTitle = activeThread?.title ?? "Details";

  return (
    <PlaceLayoutContext value={layout}>
      <ArrivingContext value={arriving}>
        <div className="group/shell relative flex h-dvh overflow-hidden bg-background pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
          {firstRun ? null : (
            <div className="hidden h-full lg:flex">
              <Sidebar folded={railed} onFold={setRailed} />
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <main
              id={firstRun ? undefined : "main-content"}
              className="flex min-h-0 min-w-0 flex-1 flex-col bg-background"
            >
              {children}
            </main>
            {firstRun ? null : <TabBar moreOpen={moreOpen} onMore={() => setMoreOpen(true)} />}
          </div>
          {pane ? (
            <aside
              aria-label={paneTitle}
              inert={!paneShown}
              className={cn(
                "hidden h-full flex-none overflow-hidden border-l bg-background transition-[width,border-color] duration-[340ms] ease-settle motion-reduce:transition-none xl:block",
                paneShown ? "w-[372px] border-foreground/[0.07]" : "w-0 border-transparent",
              )}
            >
              <div
                className={cn(
                  "auni-scrollbar-none h-full w-[372px] overflow-y-auto transition-opacity duration-200 ease-settle motion-reduce:transition-none",
                  paneShown ? "opacity-100 delay-75" : "opacity-0",
                )}
              >
                {pane}
              </div>
            </aside>
          ) : null}
          {pane ? (
            <AuniSheet
              open={sheetOpen}
              onOpenChange={(open) => setSheetFor(open ? place : null)}
              side={roomy ? "right" : "bottom"}
              title={paneTitle}
            >
              <div className="auni-scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
                {pane}
              </div>
            </AuniSheet>
          ) : null}
          <CloseMobileThreadMenuContext value={closeMore}>
            <MoreSheet open={moreOpen} onOpenChange={setMoreOpen} />
          </CloseMobileThreadMenuContext>
        </div>
      </ArrivingContext>
    </PlaceLayoutContext>
  );
}
