"use client";

import { Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import { paneOf, searchSettings, type SettingsSearchItem } from "./settings-search";

/**
 * A search over every setting, above the list of panes: while something is typed, what it
 * finds stands in the list's place, and picking one opens its pane at that setting. `/` or
 * Cmd/Ctrl+F puts the cursor in it; the arrows and Enter pick.
 */
export function SettingsSearch({
  onJump,
  phone = false,
  children,
}: {
  readonly onJump: (item: SettingsSearchItem) => void;
  readonly phone?: boolean;
  /** The list of panes, shown while nothing is typed. */
  readonly children: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const found = useMemo(() => searchSettings(query), [query]);
  const searching = query.trim() !== "";
  const at = Math.min(cursor, Math.max(found.length - 1, 0));

  useEffect(() => {
    if (phone) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable;
      const find = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f";
      if (find || (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey)) {
        event.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phone]);

  const pick = (item: SettingsSearchItem) => {
    setQuery("");
    setCursor(0);
    onJump(item);
  };

  return (
    <>
      <div className={cn("relative flex items-center", phone ? "mx-4 mt-3 mb-5" : "mx-3 mb-3")}>
        <Search aria-hidden className="pointer-events-none absolute left-3 size-4 text-faint" />
        <input
          ref={input}
          type="search"
          value={query}
          aria-label="Search settings"
          placeholder="Search"
          enterKeyHint="go"
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && searching) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            } else if (searching && found.length > 0 && event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((at + 1) % found.length);
            } else if (searching && found.length > 0 && event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((at - 1 + found.length) % found.length);
            } else if (event.key === "Enter" && found[at]) {
              event.preventDefault();
              pick(found[at]);
            }
          }}
          className={cn(
            "w-full rounded-control border border-border bg-background pr-8 pl-9 text-ink outline-none transition-[border-color,box-shadow] placeholder:text-faint focus-visible:border-foreground/20 focus-visible:ring-[3px] focus-visible:ring-ring/25 [&::-webkit-search-cancel-button]:hidden",
            phone ? "h-10 text-body" : "h-8 text-meta",
          )}
        />
        {searching ? (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setQuery("");
              input.current?.focus();
            }}
            className="absolute right-1.5 grid size-6 place-items-center rounded-control text-faint hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>
      {!searching ? (
        children
      ) : found.length === 0 ? (
        <p className="px-5 py-6 text-meta text-muted-foreground">
          Nothing in Settings matches &ldquo;{query.trim()}&rdquo;.
        </p>
      ) : (
        <ul
          role="listbox"
          aria-label="Settings found"
          className={cn("flex flex-col gap-0.5", phone ? "px-2" : "px-2.5")}
        >
          {found.map((item, index) => (
            <li key={item.target} role="option" aria-selected={index === at}>
              <button
                type="button"
                onClick={() => pick(item)}
                onMouseEnter={() => setCursor(index)}
                className={cn(
                  "flex w-full items-baseline justify-between gap-3 rounded-control px-2.5 text-left transition-colors",
                  phone ? "py-3" : "py-2",
                  index === at ? "bg-foreground/[0.07]" : "hover:bg-foreground/[0.04]",
                )}
              >
                <span
                  className={cn("truncate font-medium text-ink", phone ? "text-body" : "text-meta")}
                >
                  {item.title}
                </span>
                <span className="flex-none text-caption text-faint">
                  {paneOf(item.section).label}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
