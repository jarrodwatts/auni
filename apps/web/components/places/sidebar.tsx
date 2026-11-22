"use client";

import { useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";

import { AccountMenu } from "@/components/app/account-menu";
import { requestComposerFocus } from "@/components/app/composer";
import { useCloseMobileThreadMenu } from "@/components/app/mobile-thread-menu";
import { useStartNew } from "@/components/app/use-start-conversation";
import { Lockup } from "@/components/brand/lockup";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { PlaceLink } from "./open-place";
import { PlaceList } from "./place-list";
import { useSearch } from "./search-palette";
import { SearchPanel } from "./search-panel";
import {
  FOLD_FADE,
  FoldButton,
  NewMark,
  PlaceRow,
  RAIL_FADE,
  RailSearchRow,
  SearchButton,
} from "./sidebar-rows";

/**
 * Up top, the person's own: New thread, Portfolio with what waits on them,
 * Activity, Apps, then Pinned, Active, and Recent threads. Pinned at the foot,
 * their account.
 */
export function Sidebar({
  mobile = false,
  folded = false,
  onFold,
}: {
  readonly mobile?: boolean;
  readonly folded?: boolean;
  readonly onFold?: (folded: boolean) => void;
}) {
  const startNew = useStartNew();
  const router = useRouter();
  const { openSearch } = useSearch();

  useEffect(() => {
    if (mobile) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      if (event.key.toLocaleLowerCase() !== "o") return;
      event.preventDefault();
      router.push("/app/new");
      requestComposerFocus("new");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobile, router]);

  const logo = (
    <PlaceLink
      href="/app"
      aria-label="Portfolio"
      className="auni-touch-target flex items-center rounded-lg px-3 py-1 transition-opacity hover:opacity-75"
    >
      <Lockup height={18} priority />
    </PlaceLink>
  );

  if (mobile)
    return (
      <aside data-mobile className="group/sidebar flex h-full w-full flex-col bg-sidebar">
        <div className="flex h-14 flex-none items-center px-2">{logo}</div>
        <PhonePlaces footer={<AccountMenu />} />
      </aside>
    );

  return (
    <aside
      data-folded={folded || undefined}
      className={cn(
        "group/sidebar flex h-full flex-none overflow-clip border-r border-sidebar-border bg-sidebar transition-[width] duration-[340ms] ease-settle motion-reduce:transition-none",
        folded ? "w-[60px]" : "w-[276px]",
      )}
    >
      <TooltipProvider delayDuration={300}>
        <div className="flex h-full w-[276px] flex-none flex-col">
          <div className="relative flex h-14 flex-none items-center px-2">
            <div inert={folded} className={cn("flex flex-1 items-center", FOLD_FADE)}>
              {logo}
              <div className="ml-auto flex items-center gap-0.5">
                <SearchButton onClick={openSearch} />
                {onFold ? (
                  <FoldButton label="Fold the sidebar" onClick={() => onFold(true)} />
                ) : null}
              </div>
            </div>
            {onFold ? (
              <div inert={!folded} className={cn("absolute left-3.5", RAIL_FADE)}>
                <FoldButton label="Open the sidebar" side="right" onClick={() => onFold(false)} />
              </div>
            ) : null}
          </div>

          <div className="flex flex-none flex-col px-2 pb-1">
            <PlaceRow
              folded={folded}
              href="/app/new"
              onClick={startNew}
              mark={<NewMark />}
              title="New thread"
              keys={["⇧⌘O", "Shift+Meta+O Shift+Control+O"]}
            />
          </div>

          <nav
            aria-label="Threads"
            className="auni-list-fade auni-scrollbar-none min-h-0 flex-1 overflow-y-auto px-2 pb-12"
          >
            <PlaceList folded={folded} />
          </nav>

          <div className="flex-none">
            <div className="flex flex-col gap-px px-2 pt-2">
              <RailSearchRow folded={folded} onClick={openSearch} />
            </div>
            <AccountMenu />
          </div>
        </div>
      </TooltipProvider>
    </aside>
  );
}

export function PhonePlaces({ footer }: { readonly footer?: ReactNode }) {
  const startNew = useStartNew();
  const close = useCloseMobileThreadMenu();
  return (
    <TooltipProvider delayDuration={300}>
      <div data-mobile className="group/sidebar flex min-h-0 flex-1 flex-col">
        <SearchPanel variant="sheet" onDone={close}>
          <nav
            aria-label="Threads"
            className="auni-list-fade auni-scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-12"
          >
            <PlaceRow
              folded={false}
              href="/app/new"
              onClick={startNew}
              mark={<NewMark />}
              title="New thread"
            />
            <PlaceList />
          </nav>
        </SearchPanel>
        <div className={cn("flex-none", !footer && "pb-[max(0.5rem,env(safe-area-inset-bottom))]")}>
          {footer}
        </div>
      </div>
    </TooltipProvider>
  );
}
