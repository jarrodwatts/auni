"use client";

import type { ThreadId } from "@auni/shared";
import { PanelLeft, Plus, Search } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { shortDate } from "@/lib/dates";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { PlaceLink } from "./open-place";

/** Labels leave quickly as the sidebar folds and return once it has room, so they never squash. */
export const FOLD_FADE =
  "transition-opacity duration-200 delay-100 ease-settle group-data-folded/sidebar:opacity-0 group-data-folded/sidebar:delay-0 group-data-folded/sidebar:duration-100 motion-reduce:transition-none";

/** The reverse, for what only the rail shows. */
export const RAIL_FADE =
  "opacity-0 transition-opacity duration-100 ease-settle group-data-folded/sidebar:opacity-100 group-data-folded/sidebar:delay-100 group-data-folded/sidebar:duration-200 motion-reduce:transition-none";

export const ROW_CLASS_NAME =
  "group/row relative isolate flex items-center rounded-control outline-none before:absolute before:inset-y-0 before:right-0 before:left-0 before:-z-10 before:rounded-control before:[transition:right_340ms_var(--motion-settle),background-color_150ms] hover:before:bg-foreground/[0.04] focus-visible:before:ring-2 focus-visible:before:ring-ring focus-visible:before:ring-inset group-data-folded/sidebar:before:right-[calc(100%-44px)] motion-reduce:before:transition-none";

export const ROW_LINE_CLASS_NAME =
  "h-9 gap-2.5 px-3 text-ui group-data-mobile/sidebar:h-11 group-data-mobile/sidebar:text-reading";

/** A row with a second line under its title. */
export const ROW_DETAIL_CLASS_NAME = "h-12 group-data-mobile/sidebar:h-14";

export const ROW_ACTIVE_CLASS_NAME =
  "before:bg-foreground/[0.06] hover:before:bg-foreground/[0.06]";

export const ICON_CLASS_NAME =
  "size-[18px] text-muted-foreground transition-colors duration-150 group-hover/row:text-ink group-focus-within/row:text-ink group-aria-[current=page]/row:text-ink";
export const ICON_STROKE = 1.75;

function MarkBox({ children }: { readonly children: ReactNode }) {
  return (
    <span className="relative flex size-5 flex-none items-center justify-center">{children}</span>
  );
}

function RowKeys({ keys }: { readonly keys: string }) {
  return (
    <kbd
      className={cn(
        "flex-none font-sans text-caption text-faint opacity-0 transition-opacity duration-150 group-hover/row:opacity-100 group-focus-within/row:opacity-100 group-data-mobile/sidebar:hidden",
        FOLD_FADE,
      )}
    >
      {keys}
    </kbd>
  );
}

export function PlaceRow({
  active = false,
  folded,
  href,
  thread,
  onClick,
  mark,
  title,
  titleClassName,
  detail,
  keys,
  status,
  trailing,
  prefetch,
  className,
}: {
  readonly active?: boolean;
  readonly folded: boolean;
  readonly href: string;
  readonly thread?: ThreadId;
  readonly onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  readonly mark: ReactNode;
  readonly title: string;
  readonly titleClassName?: string;
  readonly detail?: ReactNode;
  readonly keys?: readonly [shown: string, aria: string];
  readonly status?: string;
  readonly trailing?: ReactNode;
  readonly prefetch?: false;
  readonly className?: string;
}) {
  return (
    <PlaceLink
      href={href}
      prefetch={prefetch}
      thread={thread}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-keyshortcuts={keys?.[1]}
      className={cn(
        ROW_CLASS_NAME,
        ROW_LINE_CLASS_NAME,
        detail !== undefined && ROW_DETAIL_CLASS_NAME,
        active && ROW_ACTIVE_CLASS_NAME,
        className,
      )}
    >
      {folded ? (
        <Hint label={title} keys={keys?.[0]} side="right">
          <span aria-hidden className="absolute inset-y-0 left-0 z-10 w-11" />
        </Hint>
      ) : null}
      <MarkBox>{mark}</MarkBox>
      {detail === undefined ? (
        <span className={cn("min-w-0 flex-1 truncate text-ink", titleClassName, FOLD_FADE)}>
          {title}
        </span>
      ) : (
        <span className={cn("flex min-w-0 flex-1 flex-col", FOLD_FADE)}>
          <span className="truncate leading-5 font-medium text-ink">{title}</span>
          <span className="truncate text-meta leading-[18px] text-muted-foreground group-data-mobile/sidebar:text-ui">
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

/** New's mark: the one ink disc in the sidebar, sized like every other mark. */
export function NewMark() {
  return (
    <span className="flex size-5 items-center justify-center rounded-full bg-ink text-background transition-colors duration-150 group-hover/row:bg-ink/85">
      <Plus aria-hidden className="size-3" strokeWidth={2.6} />
    </span>
  );
}

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
      <p className={cn("text-caption font-medium text-faint", FOLD_FADE)}>{children}</p>
      <span aria-hidden className={cn("absolute left-3 h-px w-5 bg-foreground/[0.1]", RAIL_FADE)} />
    </div>
  );
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short" });

/** How long since a thread last moved, as short as it can be read: "now", "12m", "2h", "Sun", "Sep 28". */
export function chatAge(at: string, now: number): string {
  const time = Date.parse(at);
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 6 * 24 * 60) return WEEKDAY.format(time);
  return shortDate(time, now);
}

function Hint({
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

const HEADER_BUTTON_CLASS_NAME =
  "group/row auni-touch-target flex size-8 flex-none items-center justify-center rounded-control transition-[background-color,transform] duration-200 ease-settle hover:bg-foreground/[0.04] focus-ring active:scale-95";

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
