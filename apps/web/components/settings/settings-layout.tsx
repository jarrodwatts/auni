"use client";

import type { ReactNode } from "react";

import { badgeClass } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cardClass } from "@/components/ui/card";
import { inputClass } from "@/components/ui/input";
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
        cardClass,
        "scroll-mt-4 transition-[border-color,box-shadow] duration-300",
        highlighted && "border-ring/50 ring-[3px] ring-ring/20",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
        <div className="min-w-0 flex-1">
          <h4 className="text-body font-semibold text-ink">{title}</h4>
          {description ? (
            <p className="mt-0.5 text-meta leading-[1.45] text-pretty text-muted-foreground">
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
          {label ? <div className="text-ui leading-5 font-medium text-ink">{label}</div> : null}
          {description ? (
            <div className="mt-0.5 text-meta leading-[1.45] text-pretty text-muted-foreground">
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

/** Each tone as the Badge primitive's: what works is neutral, what's broken waits on the owner. */
const BADGE_TONES: Record<BadgeTone, Parameters<typeof badgeClass>[0]> = {
  ok: "neutral",
  warn: "waiting",
  error: "waiting",
  accent: "neutral",
  neutral: "neutral",
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
  return <span className={cn(badgeClass(BADGE_TONES[tone]), className)}>{children}</span>;
}

/** A field in Settings: the Input primitive's, a row's height. */
export const SETTINGS_INPUT = cn(inputClass, "h-9 w-auto");

/** A lesser action in Settings. */
export const SETTINGS_BUTTON = buttonVariants({ variant: "outline", size: "sm" });

/** The one strong action in a Settings section. */
export const SETTINGS_PRIMARY_BUTTON = buttonVariants({ variant: "primary", size: "sm" });
