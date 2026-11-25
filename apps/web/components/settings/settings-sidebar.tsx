"use client";

import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Mascot } from "@/components/brand/mascot";
import { DialogTitle } from "@/components/ui/dialog";
import type { SettingsSection } from "@/lib/app-links";
import { cn } from "@/lib/utils";

import {
  SETTINGS_SECTIONS_META,
  searchSettings,
  sectionMeta,
  type SettingsSearchItem,
} from "./settings-search";

/**
 * Grouped T3 Code-inspired Settings sidebar with instant search (`/` or `Cmd/Ctrl+F`)
 * and keyboard result navigation. Collapses into a clean top bar + scrollable tabs on narrow screens.
 */
export function SettingsSidebar({
  active,
  onSelect,
  onJump,
}: {
  readonly active: SettingsSection;
  readonly onSelect: (section: SettingsSection) => void;
  readonly onJump: (section: SettingsSection, targetId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => searchSettings(query), [query]);
  const searching = query.trim().length > 0;
  const clampedCursor = results.length > 0 ? Math.min(cursor, results.length - 1) : 0;

  // Bind `/` and `Cmd/Ctrl+F` while Settings is mounted to focus the Settings search box.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target?.isContentEditable;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        return;
      }
      if (event.key === "/" && !inField && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const pickResult = (item: SettingsSearchItem) => {
    onJump(item.section, item.targetId);
    setQuery("");
    setCursor(0);
  };

  // Group sections preserving order.
  const groups = useMemo(() => {
    const ordered: {
      readonly label: string | null;
      readonly items: (typeof SETTINGS_SECTIONS_META)[number][];
    }[] = [];
    for (const meta of SETTINGS_SECTIONS_META) {
      const existing = ordered.find((g) => g.label === meta.group);
      if (existing) existing.items.push(meta);
      else ordered.push({ label: meta.group, items: [meta] });
    }
    return ordered;
  }, []);

  return (
    <aside className="flex flex-none flex-col border-b border-foreground/[0.06] bg-sidebar md:h-full md:w-[236px] md:border-r md:border-b-0">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-2.5 md:px-4 md:pt-5">
        <Mascot alt="" size={26} state="listening" />
        <DialogTitle className="text-reading font-semibold tracking-[-0.02em] text-ink">
          Settings
        </DialogTitle>
      </div>

      {/* Instant search */}
      <div className="px-3 pb-2.5 md:px-3">
        <div className="relative flex items-center">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 size-3.5 text-faint"
          />
          <input
            ref={inputRef}
            type="text"
            value={query}
            aria-label="Search settings"
            placeholder="Search settings…"
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && searching) {
                event.preventDefault();
                event.stopPropagation();
                setQuery("");
                return;
              }
              if (!searching || results.length === 0) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((i) => (i + 1) % results.length);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((i) => (i - 1 + results.length) % results.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                const picked = results[clampedCursor];
                if (picked) pickResult(picked);
              }
            }}
            className="h-8 w-full rounded-control border border-foreground/[0.08] bg-background pr-7 pl-8 text-meta text-ink outline-none transition-[border-color,box-shadow] placeholder:text-faint focus-visible:border-foreground/20 focus-visible:ring-[2px] focus-visible:ring-ring/25"
          />
          {searching ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              className="absolute right-1.5 rounded-control p-1 text-faint hover:bg-foreground/[0.05] hover:text-ink"
            >
              <X className="size-3.5" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-2 hidden rounded-control bg-surface px-1.5 py-0.5 font-mono text-caption text-faint md:inline-block">
              /
            </kbd>
          )}
        </div>
      </div>

      {/* Search results OR grouped navigation */}
      {searching ? (
        <div className="max-h-[240px] flex-1 overflow-y-auto px-2.5 pb-3 md:max-h-none">
          {results.length === 0 ? (
            <p className="px-2 py-6 text-center text-meta text-muted-foreground">
              No settings match &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5" role="listbox" aria-label="Search results">
              {results.map((item, idx) => {
                const meta = sectionMeta(item.section);
                const selected = idx === clampedCursor;
                return (
                  <li key={item.id} role="option" aria-selected={selected}>
                    <button
                      type="button"
                      onClick={() => pickResult(item)}
                      onMouseEnter={() => setCursor(idx)}
                      className={cn(
                        "flex w-full flex-col rounded-control px-2.5 py-2 text-left transition-colors",
                        selected
                          ? "bg-foreground/[0.07] text-ink"
                          : "text-ink-soft hover:bg-foreground/[0.04]",
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-meta font-medium text-ink">
                          {item.title}
                        </span>
                        <span className="flex-none text-caption text-faint">{meta.label}</span>
                      </span>
                      <span className="mt-0.5 truncate text-caption text-muted-foreground">
                        {item.description}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : (
        <nav
          aria-label="Settings sections"
          className="auni-scrollbar-none flex gap-1 overflow-x-auto px-3 pb-3 md:flex-1 md:flex-col md:gap-4 md:overflow-y-auto md:px-2.5 md:pt-1 md:pb-4"
        >
          {groups.map((group) => (
            <div key={group.label ?? "primary"} className="flex gap-1 md:flex-col md:gap-0.5">
              {group.label ? (
                <div className="hidden px-2.5 pt-1 pb-1 text-caption font-semibold tracking-[0.04em] text-faint uppercase md:block">
                  {group.label}
                </div>
              ) : null}
              {group.items.map((entry) => {
                const isCurrent = entry.id === active;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-current={isCurrent ? "page" : undefined}
                    onClick={() => onSelect(entry.id)}
                    className={cn(
                      "flex flex-none items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-ui whitespace-nowrap transition-colors duration-150 md:w-full md:py-[7px]",
                      isCurrent
                        ? "bg-foreground/[0.07] font-medium text-ink"
                        : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-ink",
                    )}
                  >
                    <entry.icon
                      aria-hidden
                      className={cn("size-4 flex-none", isCurrent ? "text-ink" : "text-faint")}
                      strokeWidth={1.85}
                    />
                    <span>{entry.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      )}
    </aside>
  );
}
