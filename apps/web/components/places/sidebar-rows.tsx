"use client";

import type { SpecialistId, ThreadId } from "@auni/shared";
import { PanelLeft, Plus, Search } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { shortDate } from "@/lib/dates";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { PlaceLink } from "./open-place";

/**
 * The sidebar folds to a rail by narrowing, not by swapping for another
 * component: every mark keeps its place, centered 30px from the left edge
 * in both states, so the eye has an anchor while the labels fade.
 */

/** Labels leave quickly as the sidebar folds and return once it has room, so they never squash. */
export const FOLD_FADE =
  "transition-opacity duration-200 delay-100 ease-settle group-data-folded/sidebar:opacity-0 group-data-folded/sidebar:delay-0 group-data-folded/sidebar:duration-100 motion-reduce:transition-none";

/** The reverse, for what only the rail shows. */
export const RAIL_FADE =
  "opacity-0 transition-opacity duration-100 ease-settle group-data-folded/sidebar:opacity-100 group-data-folded/sidebar:delay-100 group-data-folded/sidebar:duration-200 motion-reduce:transition-none";

/**
 * Every row's fill is drawn behind it, so it can shrink to a square around
 * the mark when the sidebar folds without the row itself reflowing. Grey
 * hovers; the place you're in keeps a slightly deeper grey. No elevation.
 */
export const ROW_CLASS_NAME =
  "group/row relative isolate flex items-center rounded-control outline-none before:absolute before:inset-y-0 before:right-0 before:left-0 before:-z-10 before:rounded-control before:[transition:right_340ms_var(--motion-settle),background-color_150ms] hover:before:bg-foreground/[0.04] focus-visible:before:ring-2 focus-visible:before:ring-ring/50 group-data-folded/sidebar:before:right-[calc(100%-44px)] motion-reduce:before:transition-none";

/**
 * One height and type size for every row. On a phone, taller for the thumb,
 * and 16px like the search field above them.
 */
export const ROW_LINE_CLASS_NAME =
  "h-9 gap-2.5 px-3 text-[14px] group-data-mobile/sidebar:h-11 group-data-mobile/sidebar:text-[16px]";

export const ROW_ACTIVE_CLASS_NAME =
  "before:bg-foreground/[0.06] hover:before:bg-foreground/[0.06]";

/** Every glyph in the sidebar: one size, one stroke, one grey that darkens with its row. */
export const ICON_CLASS_NAME =
  "size-[18px] text-muted-foreground transition-colors duration-150 group-hover/row:text-ink group-focus-within/row:text-ink group-aria-[current=page]/row:text-ink";
export const ICON_STROKE = 1.75;

/** Where a row's mark sits: the same box for a glyph, an orb, or New's disc. */
function MarkBox({ children }: { readonly children: ReactNode }) {
  return (
    <span className="relative flex size-5 flex-none items-center justify-center">{children}</span>
  );
}

/** A shortcut, shown at the row's end once the pointer rests on it. */
function RowKeys({ keys }: { readonly keys: string }) {
  return (
    <kbd
      className={cn(
        "flex-none font-sans text-[12px] text-faint opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-data-mobile/sidebar:hidden",
        FOLD_FADE,
      )}
    >
      {keys}
    </kbd>
  );
}

/**
 * A place, or New: its mark and name, with what waits trailing. A teammate's row is taller,
 * its name over a one-line status, like a contact list.
 */
export function PlaceRow({
  active = false,
  folded,
  href,
  specialist,
  thread,
  onClick,
  mark,
  title,
  detail,
  keys,
  status,
  trailing,
  prefetch,
  className,
}: {
  readonly active?: boolean;
  /** Folded to the rail, where the name moves into a tooltip. */
  readonly folded: boolean;
  readonly href: string;
  readonly specialist?: SpecialistId;
  readonly thread?: ThreadId;
  readonly onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  readonly mark: ReactNode;
  readonly title: string;
  /** The line under the name: how it is going. */
  readonly detail?: ReactNode;
  /** Its keyboard shortcut, as shown and as `aria-keyshortcuts` reads it. */
  readonly keys?: readonly [shown: string, aria: string];
  /** What its mark's dot says, for anyone who can't see it. */
  readonly status?: string;
  readonly trailing?: ReactNode;
  /** Off for a row that opens a popup over this page, which has nothing to fetch ahead. */
  readonly prefetch?: false;
  readonly className?: string;
}) {
  return (
    <PlaceLink
      href={href}
      prefetch={prefetch}
      specialist={specialist}
      thread={thread}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-keyshortcuts={keys?.[1]}
      className={cn(
        ROW_CLASS_NAME,
        ROW_LINE_CLASS_NAME,
        detail !== undefined && "h-12 group-data-mobile/sidebar:h-14",
        active && ROW_ACTIVE_CLASS_NAME,
        className,
      )}
    >
      {folded ? (
        // The row stays full width under the rail, so its name hangs off the visible square.
        <Hint label={title} keys={keys?.[0]} side="right">
          <span aria-hidden className="absolute inset-y-0 left-0 z-10 w-11" />
        </Hint>
      ) : null}
      <MarkBox>{mark}</MarkBox>
      {detail === undefined ? (
        <span className={cn("min-w-0 flex-1 truncate text-ink", FOLD_FADE)}>{title}</span>
      ) : (
        <span className={cn("flex min-w-0 flex-1 flex-col", FOLD_FADE)}>
          <span className="truncate leading-5 font-medium text-ink">{title}</span>
          <span className="truncate text-[12.5px] leading-[18px] text-muted-foreground group-data-mobile/sidebar:text-[14px]">
            {detail}
          </span>
        </span>
      )}
      {status ? <span className="sr-only">, {status}</span> : null}
      {keys ? <RowKeys keys={keys[0]} /> : null}
      {trailing ? <span className={cn("flex-none", FOLD_FADE)}>{trailing}</span> : null}
    </PlaceLink>
  );
}

/** New's mark: the one black thing in the sidebar, sized like every other mark. */
export function NewMark() {
  return (
    <span className="flex size-5 items-center justify-center rounded-full bg-ink text-background transition-colors duration-150 group-hover/row:bg-ink/85">
      <Plus aria-hidden className="size-3" strokeWidth={2.6} />
    </span>
  );
}

/**
 * Search's mark on the rail, atop the world's marks: the expanded sidebar
 * keeps the glass in its header instead, so here the row folds away to nothing.
 */
export function RailSearchRow({
  folded,
  onClick,
}: {
  readonly folded: boolean;
  readonly onClick: () => void;
}) {
  return (
    <div
      inert={!folded}
      className={cn(
        "flex-none overflow-hidden transition-[height,opacity] duration-[340ms] ease-settle motion-reduce:transition-none",
        folded ? "h-[37px] opacity-100" : "h-0 opacity-0",
      )}
    >
      <Hint label="Search" keys="⌘K" side="right">
        <button
          type="button"
          aria-label="Search"
          aria-keyshortcuts="Meta+K Control+K"
          onClick={onClick}
          className={cn(ROW_CLASS_NAME, ROW_LINE_CLASS_NAME, "w-full")}
        >
          <MarkBox>
            <Search aria-hidden className={ICON_CLASS_NAME} strokeWidth={ICON_STROKE} />
          </MarkBox>
        </button>
      </Hint>
    </div>
  );
}

/** A section's name; on the rail it becomes a short rule between groups of marks. */
export function SectionLabel({ children }: { readonly children: string }) {
  return (
    <div className="relative mt-5 mb-1 flex h-5 items-center px-3">
      <p className={cn("text-[12px] font-medium text-faint", FOLD_FADE)}>{children}</p>
      <span aria-hidden className={cn("absolute left-3 h-px w-5 bg-foreground/[0.1]", RAIL_FADE)} />
    </div>
  );
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });

/** How long since a chat last moved, as short as it can be read: "now", "12m", "2h", "Sun", "Sep 28". */
export function chatAge(at: string, now: number): string {
  const time = Date.parse(at);
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 6 * 24 * 60) return WEEKDAY.format(time);
  return shortDate(time, now);
}

/** A control's name, and its shortcut, once the pointer rests on it. */
export function Hint({
  label,
  keys,
  side,
  children,
}: {
  readonly label: string;
  readonly keys?: string;
  readonly side: "bottom" | "right";
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} sideOffset={side === "right" ? 10 : 6}>
        {label}
        {keys ? <span className="ml-2 text-background/60">{keys}</span> : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** A header control: a bare glyph that greys in under the pointer. */
const HEADER_BUTTON_CLASS_NAME =
  "group/row auni-touch-target flex size-8 flex-none items-center justify-center rounded-control outline-none transition-[background-color,transform] duration-200 ease-settle hover:bg-foreground/[0.04] focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-95";

/** Opens search, beside the fold. */
export function SearchButton({ onClick }: { readonly onClick: () => void }) {
  return (
    <Hint label="Search" keys="⌘K" side="bottom">
      <button
        type="button"
        aria-label="Search"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={onClick}
        className={HEADER_BUTTON_CLASS_NAME}
      >
        <Search aria-hidden className={ICON_CLASS_NAME} strokeWidth={ICON_STROKE} />
      </button>
    </Hint>
  );
}

export function FoldButton({
  label,
  onClick,
  side = "bottom",
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly side?: "bottom" | "right";
}) {
  return (
    <Hint label={label} side={side}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className={HEADER_BUTTON_CLASS_NAME}
      >
        <PanelLeft aria-hidden className={ICON_CLASS_NAME} strokeWidth={ICON_STROKE} />
      </button>
    </Hint>
  );
}
