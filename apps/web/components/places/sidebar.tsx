"use client";

import "./sidebar.css";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { AccountMenu } from "@/components/app/account-menu";
import { requestComposerFocus } from "@/components/app/composer";
import { useStartNew } from "@/components/app/use-start-conversation";
import { Lockup } from "@/components/brand/lockup";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { PlaceLink } from "./open-place";
import { PlaceList } from "./place-list";
import { useSearch } from "./search-palette";
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
 * A wide screen's way around: New take, Money, Apps, then what needs the owner, their takes and
 * their chats, and their account at the foot. It folds to a rail of marks. A phone has the tab
 * bar instead.
 */
export function Sidebar({
  folded = false,
  onFold,
}: {
  readonly folded?: boolean;
  readonly onFold?: (folded: boolean) => void;
}) {
  const startNew = useStartNew();
  const router = useRouter();
  const { openSearch } = useSearch();

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      if (event.key.toLocaleLowerCase() !== "o") return;
      event.preventDefault();
      router.push("/app/new");
      requestComposerFocus("new");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  const logo = (
    <PlaceLink
      href="/app/new"
      onClick={startNew}
      aria-label="New take"
      className="auni-touch-target flex items-center rounded-card px-3 py-1 transition-opacity hover:opacity-75"
    >
      <Lockup height={18} priority />
    </PlaceLink>
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
                  <FoldButton label="Collapse sidebar" onClick={() => onFold(true)} />
                ) : null}
              </div>
            </div>
            {onFold ? (
              <div inert={!folded} className={cn("absolute left-3.5", RAIL_FADE)}>
                <FoldButton label="Expand sidebar" side="right" onClick={() => onFold(false)} />
              </div>
            ) : null}
          </div>

          <div className="flex flex-none flex-col px-2 pb-1">
            <PlaceRow
              folded={folded}
              href="/app/new"
              onClick={startNew}
              mark={<NewMark />}
              title="New take"
              keys={["⇧⌘O", "Shift+Meta+O Shift+Control+O"]}
            />
          </div>

          <nav
            aria-label="Chats"
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
