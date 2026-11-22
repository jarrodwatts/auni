"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * T3 Code-inspired Settings section: clear heading + short subtitle above a crisp bordered card,
 * with optional highlight ring when jumped to from Settings search.
 */
export function SettingsSection({
  id,
  title,
  description,
  action,
  highlighted = false,
  children,
}: {
  readonly id?: string;
  readonly title: string;
  readonly description?: string;
  readonly action?: ReactNode;
  readonly highlighted?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <section
      id={id}
      data-highlighted={highlighted ? "true" : undefined}
      className={cn(
        "scroll-mt-4 rounded-[16px] border bg-card transition-[border-color,box-shadow] duration-300",
        highlighted ? "border-primary/50 ring-[3px] ring-ring/25" : "border-foreground/[0.08]",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-foreground/[0.06] px-4 py-3.5 sm:px-5">
        <div className="min-w-0 flex-1">
          <h4 className="text-[14.5px] leading-5 font-semibold tracking-[-0.015em] text-ink">
            {title}
          </h4>
          {description ? (
            <p className="mt-0.5 text-[12.5px] leading-[1.45] text-pretty text-muted-foreground">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="flex-none">{action}</div> : null}
      </div>
      <div className="divide-y divide-foreground/[0.06]">{children}</div>
    </section>
  );
}

/** One structured setting row inside a SettingsSection. */
export function SettingsRow({
  id,
  label,
  description,
  highlighted = false,
  stacked = false,
  children,
  className,
}: {
  readonly id?: string;
  readonly label?: ReactNode;
  readonly description?: ReactNode;
  readonly highlighted?: boolean;
  readonly stacked?: boolean;
  readonly children?: ReactNode;
  readonly className?: string;
}) {
  return (
    <div
      id={id}
      className={cn(
        "scroll-mt-4 px-4 py-3.5 transition-colors duration-300 sm:px-5",
        stacked
          ? "flex flex-col gap-3"
          : "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4",
        highlighted && "bg-primary/[0.06]",
        className,
      )}
    >
      {label || description ? (
        <div className="min-w-0 flex-1">
          {label ? (
            <div className="text-[13.5px] leading-5 font-medium text-ink">{label}</div>
          ) : null}
          {description ? (
            <div className="mt-0.5 text-[12.5px] leading-[1.45] text-pretty text-muted-foreground">
              {description}
            </div>
          ) : null}
        </div>
      ) : null}
      {children ? <div className={cn("flex-none", stacked && "w-full")}>{children}</div> : null}
    </div>
  );
}

export type BadgeTone = "ok" | "warn" | "error" | "accent" | "neutral";

const BADGE_STYLES: Record<BadgeTone, string> = {
  ok: "bg-positive/[0.12] text-positive",
  warn: "bg-warning-surface text-warning",
  error: "bg-destructive/[0.12] text-destructive",
  accent: "bg-primary/[0.12] text-primary",
  neutral: "bg-surface text-muted-foreground",
};

/** Compact semantic status pill, always derived from Auni's design tokens. */
export function SettingsBadge({
  tone = "neutral",
  children,
  className,
}: {
  readonly tone?: BadgeTone;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11.5px] leading-4 font-medium whitespace-nowrap",
        BADGE_STYLES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Shared input class matching Auni's calm rounded control style. */
export const SETTINGS_INPUT =
  "h-9 rounded-[10px] border border-foreground/[0.1] bg-background px-3 text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] placeholder:text-faint focus-visible:border-foreground/25 focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:opacity-60";

/** Shared secondary pill button for Settings actions. */
export const SETTINGS_BUTTON =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-[9px] border border-foreground/[0.1] bg-background px-3 text-[12.5px] font-medium text-ink transition-colors hover:bg-foreground/[0.04] focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50";

/** Shared primary pill button for Settings actions. */
export const SETTINGS_PRIMARY_BUTTON =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-[9px] bg-foreground px-3.5 text-[12.5px] font-medium text-background transition-colors hover:bg-foreground/85 focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50";
