"use client";

import { Check, ChevronRight } from "lucide-react";
import { createContext, useContext, useState, type ReactNode } from "react";

import { badgeClass } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { cardClass } from "@/components/ui/card";
import { inputClass } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Settings is built from three things: a group (a quiet heading over one card of rows), a
 * setting (one row: what it is, a line on what it does, and its control), and a disclosure (a
 * row that opens to show what most owners never need, such as the developer's detail). A
 * search result lands on a group, a setting or a disclosure by its id, which flashes and, for a
 * disclosure, opens.
 */

/** The id a search jumped to, for the one setting, group or disclosure that has it. */
export const JumpedTo = createContext<string | null>(null);

function useJumped(id: string | undefined): boolean {
  const jumped = useContext(JumpedTo);
  return id !== undefined && jumped === id;
}

/** A group of settings: a quiet heading (or none), one card of rows, and a line under it. */
export function SettingsGroup({
  id,
  title,
  note,
  children,
}: {
  readonly id?: string;
  readonly title?: string;
  /** A line under the card, for what's true of every row in it. */
  readonly note?: ReactNode;
  readonly children: ReactNode;
}) {
  const jumped = useJumped(id);
  return (
    <section id={id} aria-label={title} className="scroll-mt-6">
      {title ? (
        <h3 className="mb-2 px-1 text-meta font-medium text-muted-foreground">{title}</h3>
      ) : null}
      <div
        className={cn(
          cardClass,
          "divide-y divide-border transition-[box-shadow] duration-500",
          jumped && "ring-[3px] ring-ring/25",
        )}
      >
        {children}
      </div>
      {note ? (
        <p className="mt-2 px-1 text-meta leading-[1.5] text-muted-foreground">{note}</p>
      ) : null}
    </section>
  );
}

/**
 * One setting: its name, a line on what it does, and its control at the end, or under it
 * (`stacked`) where the control needs the width.
 */
export function Setting({
  id,
  label,
  hint,
  stacked = false,
  inline = false,
  children,
}: {
  readonly id?: string;
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly stacked?: boolean;
  /** A control small enough to stay beside its words even on a phone: a switch. */
  readonly inline?: boolean;
  readonly children?: ReactNode;
}) {
  const jumped = useJumped(id);
  return (
    <div
      id={id}
      className={cn(
        "flex scroll-mt-6 flex-col gap-3 px-4 py-3.5 transition-colors duration-500 sm:px-5",
        !stacked && "sm:flex-row sm:items-center sm:justify-between sm:gap-5",
        inline && "flex-row items-center justify-between gap-5",
        jumped && "bg-primary/[0.06]",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-ui font-medium text-ink">{label}</div>
        {hint ? (
          <div className="mt-0.5 text-meta leading-[1.45] text-pretty text-muted-foreground">
            {hint}
          </div>
        ) : null}
      </div>
      {children ? (
        <div className={cn("min-w-0", !stacked && "sm:flex-none")}>{children}</div>
      ) : null}
    </div>
  );
}

/** A row that does one thing when pressed: open a dialog, go to another pane. */
export function SettingLink({
  icon,
  label,
  hint,
  disabled = false,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-3.5 px-4 py-3.5 text-left transition-colors duration-150 outline-none hover:bg-foreground/[0.03] focus-visible:bg-foreground/[0.04] disabled:cursor-not-allowed disabled:opacity-50 sm:px-5"
    >
      <span className="flex size-8 flex-none items-center justify-center rounded-control bg-surface text-ink-soft [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-medium text-ink">{label}</span>
        {hint ? <span className="mt-0.5 block text-meta text-muted-foreground">{hint}</span> : null}
      </span>
      <ChevronRight aria-hidden className="size-4 flex-none text-faint" />
    </button>
  );
}

/**
 * What most owners never need, folded under one quiet line ("For developers", "Show every
 * check"): opened by a tap, or by a search that lands on it or on anything inside (`holds`).
 */
export function Disclosure({
  id,
  title,
  hint,
  holds = [],
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly hint?: string;
  /** Ids of what sits inside it, which a search may land on. */
  readonly holds?: readonly string[];
  readonly children: ReactNode;
}) {
  const jumped = useContext(JumpedTo);
  const [open, setOpen] = useState(false);
  const shown = open || (jumped !== null && (jumped === id || holds.includes(jumped)));
  return (
    <section id={id} className="scroll-mt-6">
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => setOpen(!shown)}
        className="group flex w-full items-center gap-2 rounded-control px-1 py-1.5 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            "size-4 flex-none text-faint transition-transform duration-200 ease-settle",
            shown && "rotate-90",
          )}
        />
        <span className="text-meta font-medium text-muted-foreground group-hover:text-ink">
          {title}
        </span>
        {hint && !shown ? <span className="truncate text-meta text-faint">{hint}</span> : null}
      </button>
      {shown ? <div className="auni-field-in mt-3 flex flex-col gap-6">{children}</div> : null}
    </section>
  );
}

/** "Saved", for a moment, beside what was just saved. */
export function Saved({ children = "Saved" }: { readonly children?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-1 text-caption text-muted-foreground">
      <Check aria-hidden className="size-3.5" />
      {children}
    </span>
  );
}

/** A line saying what went wrong, in place of what it was about. */
export function Refusal({ children }: { readonly children: ReactNode }) {
  return (
    <p role="alert" className="text-meta leading-[1.45] text-destructive">
      {children}
    </p>
  );
}

/**
 * A state word as a pill, in the tones first run's wizard names them; each the Badge primitive's:
 * what works is neutral, what's broken waits on the owner.
 */
export function SettingsBadge({
  tone = "neutral",
  children,
}: {
  readonly tone?: "ok" | "warn" | "error" | "accent" | "neutral";
  readonly children: ReactNode;
}) {
  const badge = {
    ok: "neutral",
    warn: "waiting",
    error: "waiting",
    accent: "neutral",
    neutral: "neutral",
  } as const;
  return <span className={badgeClass(badge[tone])}>{children}</span>;
}

/** A field in Settings: the Input primitive's, a row's height. */
export const SETTINGS_INPUT = cn(inputClass, "h-9 w-auto");

/** A lesser action in Settings. */
export const SETTINGS_BUTTON = buttonVariants({ variant: "outline", size: "sm" });

/** The one strong action in a Settings group. */
export const SETTINGS_PRIMARY_BUTTON = buttonVariants({ variant: "primary", size: "sm" });

/** How long "Saved" stays beside what was saved. */
export const SAVED_MS = 2_000;
