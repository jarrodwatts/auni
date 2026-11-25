"use client";

import { Search, X } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { useStartConversation } from "@/components/app/use-start-conversation";
import { Mascot } from "@/components/brand/mascot";
import { cn } from "@/lib/utils";

import { PlaceLink } from "./open-place";
import { type SearchGroup, type SearchItem, useSearchGroups } from "./search-items";
import { useSearch } from "./search-palette";

/**
 * Search and ask in one field: what's typed finds places, chats, holdings,
 * pages and people, and the last row always asks Auni instead, so a search
 * never dead-ends. Arrows move, Enter opens, the pointer points.
 */
export function SearchPanel({
  variant,
  inputRef,
  onDone,
  children,
}: {
  /** The ⌘K palette, or the field atop a phone's places sheet. */
  readonly variant: "palette" | "sheet";
  readonly inputRef?: RefObject<HTMLInputElement | null>;
  /** Something was picked: close whatever holds the panel. */
  readonly onDone: () => void;
  /** Shown instead of results while nothing is typed; the palette shows recent places. */
  readonly children?: ReactNode;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { withdraw } = useSearch();
  const { start } = useStartConversation();
  const groups = useSearchGroups(query, withdraw);
  const needle = query.trim();
  const items = groups.flatMap((group) => group.items);
  const count = items.length + (needle ? 1 : 0);
  const showResults = needle.length > 0 || !children;
  const current = Math.min(active, count - 1);
  const optionId = (index: number) => `${id}-option-${index}`;
  // Where each group's rows start in the one list the arrows walk.
  const starts = groups.map((_, at) =>
    groups.slice(0, at).reduce((sum, group) => sum + group.items.length, 0),
  );

  // Each new query starts on its best match.
  const type = (next: string) => {
    setQuery(next);
    setActive(0);
  };

  useEffect(() => {
    listRef.current
      ?.querySelector(`[id="${CSS.escape(optionId(current))}"]`)
      ?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the id is stable
  }, [current]);

  const ask = () => {
    onDone();
    void start(needle);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || !showResults || count === 0) return;
    const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    if (move) {
      event.preventDefault();
      setActive((current + move + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      // The row does what a click on it would, modifier keys and all.
      listRef.current
        ?.querySelector<HTMLElement>(`[id="${CSS.escape(optionId(current))}"]`)
        ?.click();
    }
  };

  const sheet = variant === "sheet";

  return (
    <div className={cn("flex min-h-0 flex-col", sheet ? "flex-1" : "")}>
      <label
        className={cn(
          "flex flex-none items-center",
          sheet
            ? "mx-2 mb-2 h-11 gap-2.5 rounded-control bg-foreground/[0.045] px-3 transition-colors duration-150 focus-within:bg-foreground/[0.06]"
            : cn(
                "h-14 gap-3 px-5",
                showResults && count > 0 && "border-b border-foreground/[0.06]",
              ),
        )}
      >
        <Search
          aria-hidden
          className={cn("flex-none text-faint", sheet ? "size-[18px]" : "size-5")}
          strokeWidth={1.75}
        />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => type(event.target.value)}
          onKeyDown={onKeyDown}
          autoFocus={!sheet}
          role="combobox"
          aria-label="Search or ask Auni"
          aria-expanded={showResults && count > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={showResults && count > 0 ? optionId(current) : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          placeholder={sheet ? "Search or ask" : "Search or ask Auni"}
          className={cn(
            "h-full min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-faint",
            // 16px on a phone, so focusing never zooms the page.
            sheet ? "text-reading" : "text-reading tracking-[-0.01em]",
          )}
        />
        {query ? (
          <button
            type="button"
            aria-label="Clear"
            onClick={(event) => {
              type("");
              // Back into the field, ready for the next search.
              event.currentTarget.parentElement?.querySelector("input")?.focus();
            }}
            className="-mr-1 flex size-7 flex-none items-center justify-center rounded-full text-faint transition-colors duration-150 hover:bg-foreground/[0.05] hover:text-ink"
          >
            <X aria-hidden className="size-4" strokeWidth={2} />
          </button>
        ) : sheet ? null : (
          <kbd className="flex-none rounded-control border border-foreground/[0.08] px-1.5 py-0.5 font-sans text-caption text-faint">
            esc
          </kbd>
        )}
      </label>

      {showResults ? (
        <div
          ref={listRef}
          id={`${id}-list`}
          role="listbox"
          aria-label="Results"
          className={cn(
            "auni-scrollbar-none overflow-y-auto overscroll-contain",
            sheet ? "min-h-0 flex-1 px-2 pb-3" : "max-h-[min(440px,56vh)] p-2",
            !sheet && count === 0 && "hidden",
          )}
        >
          {groups.map((group, groupAt) => (
            <Group key={group.label} group={group}>
              {group.items.map((item, itemAt) => {
                const at = (starts[groupAt] ?? 0) + itemAt;
                return (
                  <Row
                    key={item.key}
                    id={optionId(at)}
                    item={item}
                    active={at === current}
                    sheet={sheet}
                    onPoint={() => setActive(at)}
                    onDone={onDone}
                  />
                );
              })}
            </Group>
          ))}
          {needle ? (
            <AskRow
              id={optionId(items.length)}
              text={needle}
              active={current === items.length}
              alone={items.length === 0}
              sheet={sheet}
              onPoint={() => setActive(items.length)}
              onAsk={ask}
            />
          ) : null}
        </div>
      ) : (
        children
      )}
    </div>
  );
}

function Group({ group, children }: { readonly group: SearchGroup; readonly children: ReactNode }) {
  return (
    <div role="group" aria-label={group.label} className="pb-1 first:pt-0">
      <p
        aria-hidden
        className="px-3 pt-2.5 pb-1 text-caption font-medium text-faint group-data-mobile/sidebar:pt-3"
      >
        {group.label}
      </p>
      {children}
    </div>
  );
}

/** Grey answers the cursor and the arrow keys alike; nothing else lights up. */
const ROW_CLASS_NAME =
  "relative isolate flex w-full items-center gap-3 rounded-control px-3 text-left outline-none before:absolute before:inset-0 before:-z-10 before:rounded-control before:transition-colors before:duration-100 aria-selected:before:bg-foreground/[0.05] motion-reduce:before:transition-none";

function rowSize(sheet: boolean) {
  return sheet ? "h-12 text-reading" : "h-10 text-ui";
}

function Row({
  id,
  item,
  active,
  sheet,
  onPoint,
  onDone,
}: {
  readonly id: string;
  readonly item: SearchItem;
  readonly active: boolean;
  readonly sheet: boolean;
  readonly onPoint: () => void;
  readonly onDone: () => void;
}) {
  const body = (
    <>
      <span aria-hidden className="flex size-5 flex-none items-center justify-center">
        {item.mark}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="min-w-0 flex-none truncate text-ink [max-width:70%]">{item.title}</span>
        {item.detail ? (
          <span className="min-w-0 flex-1 truncate text-meta text-faint">{item.detail}</span>
        ) : null}
      </span>
      {item.trailing ? (
        <span className="flex-none text-meta text-muted-foreground tabular-nums">
          {item.trailing}
        </span>
      ) : null}
    </>
  );
  const shared = {
    id,
    role: "option",
    "aria-selected": active,
    tabIndex: -1,
    onPointerMove: active ? undefined : onPoint,
    className: cn(ROW_CLASS_NAME, rowSize(sheet)),
  } as const;
  return "href" in item ? (
    <PlaceLink
      {...shared}
      href={item.href}
      thread={item.thread}
      onClick={(event) => {
        item.onClick?.(event);
        onDone();
      }}
    >
      {body}
    </PlaceLink>
  ) : (
    <button
      {...shared}
      type="button"
      onClick={() => {
        onDone();
        item.run();
      }}
    >
      {body}
    </button>
  );
}

/** The way out of every search: ask Auni what was typed, in a new chat. */
function AskRow({
  id,
  text,
  active,
  alone,
  sheet,
  onPoint,
  onAsk,
}: {
  readonly id: string;
  readonly text: string;
  readonly active: boolean;
  /** Nothing else matched, so it's the answer, not an aside. */
  readonly alone: boolean;
  readonly sheet: boolean;
  readonly onPoint: () => void;
  readonly onAsk: () => void;
}) {
  return (
    <div className={cn(!alone && "mt-1 border-t border-foreground/[0.06] pt-1")}>
      <button
        id={id}
        type="button"
        role="option"
        aria-selected={active}
        tabIndex={-1}
        onPointerMove={active ? undefined : onPoint}
        onClick={onAsk}
        className={cn(ROW_CLASS_NAME, rowSize(sheet))}
      >
        <span aria-hidden className="flex size-5 flex-none items-center justify-center">
          <Mascot alt="" state="listening" size={20} className="size-5" />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="flex-none font-medium text-ink">Ask Auni</span>
          <span className="min-w-0 truncate text-muted-foreground">&ldquo;{text}&rdquo;</span>
        </span>
      </button>
    </div>
  );
}
