"use client";

import { Plus } from "lucide-react";

import { useStartNew } from "@/components/app/use-start-conversation";
import { buttonVariants } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { PlaceLink } from "./open-place";
import { PlaceHeader } from "./place-header";
import { PlaceList } from "./place-list";
import { SearchPanel } from "./search-panel";
import { usePlaces } from "./use-places";

/**
 * A phone's Chats tab: search, then what needs the owner, their takes and their chats, with a
 * new take one tap away. On a wide screen the sidebar holds the same list.
 */
export function ChatsPlace() {
  const startNew = useStartNew();
  const { chats } = usePlaces();
  const newTake = (
    <PlaceLink
      href="/app/new"
      onClick={startNew}
      className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}
    >
      <Plus aria-hidden className="size-4" strokeWidth={2.25} />
      New take
    </PlaceLink>
  );
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col">
      <PlaceHeader root icon={null} title="Chats" actions={newTake} />
      <TooltipProvider delayDuration={300}>
        <div
          data-mobile
          className="group/sidebar mx-auto flex min-h-0 w-full max-w-[680px] flex-1 flex-col pt-3"
        >
          <SearchPanel variant="sheet" onDone={() => undefined}>
            <nav
              aria-label="Chats"
              className="auni-list-fade auni-scrollbar-none min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-12"
            >
              {chats.length === 0 ? (
                <p className="px-3 pt-10 text-center text-ui text-muted-foreground">
                  Your takes and chats will appear here. Tap New take to start one.
                </p>
              ) : (
                <PlaceList nav={false} />
              )}
            </nav>
          </SearchPanel>
        </div>
      </TooltipProvider>
    </section>
  );
}
