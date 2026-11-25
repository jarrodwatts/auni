"use client";

import {
  ChevronRight,
  Ellipsis,
  Hand,
  LayoutGrid,
  MessageCircle,
  Plus,
  Settings,
} from "lucide-react";
import type { ReactNode } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { VaultArt } from "@/components/brand/vault-art";
import { useMe } from "@/components/personalization/use-me";
import { AuniSheet } from "@/components/ui/auni-sheet";
import { APPS_HREF, CHATS_HREF, NEEDS_YOU_HREF } from "@/lib/app-links";
import { UNNAMED_OWNER } from "@/lib/account-display";
import { cn } from "@/lib/utils";

import { PlaceLink } from "./open-place";
import { PortfolioMark } from "./place-marks";
import { usePlaceRoute, usePlaces } from "./use-places";

const TAB_CLASS_NAME =
  "group/tab relative flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 pt-1.5 text-caption font-medium outline-none transition-colors duration-150 focus-visible:text-ink";
const ICON = "size-[22px]";

/**
 * A phone's way around, at the thumb: Chats, Money, Needs you, and More for the rest. It stands
 * under every place but a chat, which is the whole screen, and steps aside while the owner types.
 */
export function TabBar({
  moreOpen,
  onMore,
}: {
  readonly moreOpen: boolean;
  readonly onMore: () => void;
}) {
  const route = usePlaceRoute();
  const { waitingCount } = usePlaces();
  if (route.kind === "chat") return null;
  const tab = (active: boolean) =>
    cn(TAB_CLASS_NAME, active ? "text-ink" : "text-faint hover:text-ink-soft");

  return (
    <nav
      aria-label="Places"
      className="flex flex-none border-t border-border bg-background pb-[env(safe-area-inset-bottom)] pointer-coarse:group-has-[textarea:focus]/shell:hidden lg:hidden"
    >
      <PlaceLink
        href={CHATS_HREF}
        aria-current={route.kind === "chats" || route.kind === "new" ? "page" : undefined}
        className={tab(route.kind === "chats" || route.kind === "new")}
      >
        <TabMark>
          <MessageCircle aria-hidden className={ICON} strokeWidth={1.75} />
        </TabMark>
        Chats
      </PlaceLink>
      <PlaceLink
        href="/app"
        aria-current={route.kind === "portfolio" ? "page" : undefined}
        className={tab(route.kind === "portfolio" || route.kind === "activity")}
      >
        <TabMark>
          <PortfolioMark size={22} />
        </TabMark>
        Money
      </PlaceLink>
      <PlaceLink
        href={NEEDS_YOU_HREF}
        aria-current={route.kind === "needs-you" ? "page" : undefined}
        className={tab(route.kind === "needs-you")}
      >
        <TabMark badge={waitingCount}>
          <Hand aria-hidden className={ICON} strokeWidth={1.75} />
        </TabMark>
        Needs you
        {waitingCount > 0 ? <span className="sr-only">, {waitingCount} waiting</span> : null}
      </PlaceLink>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        onClick={onMore}
        className={tab(route.kind === "apps" || moreOpen)}
      >
        <TabMark>
          <Ellipsis aria-hidden className={ICON} strokeWidth={1.75} />
        </TabMark>
        More
      </button>
    </nav>
  );
}

/** A tab's glyph, with an amber count on it when something waits. */
function TabMark({
  children,
  badge = 0,
}: {
  readonly children: ReactNode;
  readonly badge?: number;
}) {
  return (
    <span className="relative flex h-7 items-center justify-center">
      {children}
      {badge > 0 ? (
        <span
          aria-hidden
          className="absolute -top-0.5 left-[calc(50%+6px)] flex h-4 min-w-4 items-center justify-center rounded-full bg-waiting-mark px-1 text-caption leading-none font-semibold text-paper tabular-nums ring-2 ring-background"
        >
          {badge}
        </span>
      ) : null}
    </span>
  );
}

const MORE_ROW_CLASS_NAME =
  "flex h-14 w-full items-center gap-3.5 rounded-control px-3 text-left text-body text-ink outline-none transition-colors duration-150 hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/50 active:bg-foreground/[0.06]";

/** More, as a sheet from the bottom: the owner, then Apps, Add money and Settings. */
export function MoreSheet({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const me = useMe();
  const { openAddMoney, openSettings } = useAppDialogs();
  const run = (open: () => void) => () => {
    onOpenChange(false);
    open();
  };
  const chevron = <ChevronRight aria-hidden className="ml-auto size-4 text-faint" />;

  return (
    <AuniSheet open={open} onOpenChange={onOpenChange} side="bottom" title="More">
      <div className="flex flex-col px-3 pt-5 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mb-2 flex items-center gap-3 px-3 pb-3">
          <span className="relative flex size-10 flex-none">
            <VaultArt className="absolute inset-0 size-10" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-body font-semibold text-ink">
              {me.name ?? UNNAMED_OWNER}
            </span>
            <span className="block truncate text-meta text-muted-foreground">
              On {me.reach.machine}
            </span>
          </span>
        </div>
        <PlaceLink href={APPS_HREF} className={MORE_ROW_CLASS_NAME}>
          <LayoutGrid aria-hidden className="size-5 text-muted-foreground" strokeWidth={1.75} />
          Apps
          {chevron}
        </PlaceLink>
        <button type="button" onClick={run(openAddMoney)} className={MORE_ROW_CLASS_NAME}>
          <Plus aria-hidden className="size-5 text-muted-foreground" strokeWidth={1.75} />
          Add money
          {chevron}
        </button>
        <button type="button" onClick={run(() => openSettings())} className={MORE_ROW_CLASS_NAME}>
          <Settings aria-hidden className="size-5 text-muted-foreground" strokeWidth={1.75} />
          Settings
          {chevron}
        </button>
      </div>
    </AuniSheet>
  );
}
