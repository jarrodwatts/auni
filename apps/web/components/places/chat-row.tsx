"use client";

import { useEffect, useRef, useState } from "react";

import type { Thread } from "@/lib/data/views";
import { cn } from "@/lib/utils";

import type { ChatStatus } from "./attention";
import { ChatMenu, MAX_TITLE_CHARS, useTidyChat } from "./chat-menu";
import { useLongPress } from "./long-press";
import { PlaceLink } from "./open-place";
import { ATTENTION_LABEL, ChatStatusMark } from "./place-marks";
import { ROW_ACTIVE_CLASS_NAME, ROW_CLASS_NAME, ROW_LINE_CLASS_NAME } from "./sidebar-rows";

/**
 * A chat's "…" shows once the pointer rests on its row or focus moves in, and stays while its
 * menu is open. A touch screen has no resting pointer, so there the open chat keeps it, and a
 * long press on any row opens its menu.
 */
const REVEAL_ACTIONS =
  "group-hover/chat:opacity-100 group-hover/chat:pointer-events-auto group-focus-within/chat:opacity-100 group-focus-within/chat:pointer-events-auto group-data-menu/chat:opacity-100 group-data-menu/chat:pointer-events-auto pointer-coarse:group-data-active/chat:opacity-100 pointer-coarse:group-data-active/chat:pointer-events-auto";

/** What the "…" covers: the mark steps aside, and the title fades out sooner. */
const MAKE_ROOM =
  "group-hover/chat:pr-10 group-focus-within/chat:pr-10 group-data-menu/chat:pr-10 pointer-coarse:group-data-active/chat:pr-12";
const STEP_ASIDE =
  "group-hover/chat:hidden group-focus-within/chat:hidden group-data-menu/chat:hidden pointer-coarse:group-data-active/chat:hidden";

/**
 * A title Auni is working under catches a sheen, soft enough to stay readable.
 * With less motion it holds still, greyed.
 */
const WORKING_TITLE =
  "shimmer shimmer-color-ink/50 motion-reduce:shimmer-none motion-reduce:text-muted-foreground";

/**
 * A chat: just its words, no money and no date, since the list runs newest
 * first. Its title shimmers while Auni works in it and is heavier while a
 * reply waits unread; trailing it, "Your turn" when something waits on you,
 * or the ring of money moving. A long title fades out rather than breaking
 * mid-word. Its "…" renames it in place, archives it or deletes it.
 */
export function ChatRow({
  active,
  href,
  thread,
  status,
}: {
  readonly active: boolean;
  readonly href: string;
  readonly thread: Thread;
  readonly status: ChatStatus;
}) {
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const refocus = useRef(false);
  const { rename } = useTidyChat(thread);
  const press = useLongPress(() => setMenu(true));

  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    linkRef.current?.focus();
  }, [editing]);

  const finishEditing = (next: string | null, byKey: boolean) => {
    const trimmed = next?.trim();
    if (trimmed && trimmed !== thread.title) void rename(trimmed);
    refocus.current = byKey;
    setEditing(false);
  };

  return (
    <li
      data-active={active || undefined}
      data-menu={menu || undefined}
      className="group/chat relative"
    >
      {editing ? (
        <TitleField title={thread.title} onDone={finishEditing} />
      ) : (
        <>
          <PlaceLink
            ref={linkRef}
            href={href}
            thread={thread.id}
            aria-current={active ? "page" : undefined}
            {...press}
            className={cn(
              ROW_CLASS_NAME,
              ROW_LINE_CLASS_NAME,
              "select-none [-webkit-touch-callout:none] group-hover/chat:before:bg-foreground/[0.04]",
              MAKE_ROOM,
              active && [ROW_ACTIVE_CLASS_NAME, "group-hover/chat:before:bg-foreground/[0.06]"],
            )}
          >
            <span
              className={cn(
                "auni-row-fade min-w-0 flex-1 overflow-hidden whitespace-nowrap text-ink",
                status.unread && "font-semibold",
                status.working && WORKING_TITLE,
              )}
            >
              {thread.title}
            </span>
            {status.working ? <span className="sr-only">Working</span> : null}
            {status.unread ? <span className="sr-only">{ATTENTION_LABEL.unread}</span> : null}
            <ChatStatusMark mark={status.mark} className={STEP_ASIDE} />
          </PlaceLink>
          <div
            className={cn(
              "pointer-events-none absolute inset-y-0 right-1.5 flex items-center opacity-0 transition-opacity duration-150 motion-reduce:transition-none",
              REVEAL_ACTIONS,
            )}
          >
            <ChatMenu
              thread={thread}
              place="row"
              open={menu}
              onOpenChange={setMenu}
              onRename={() => setEditing(true)}
            />
          </div>
        </>
      )}
    </li>
  );
}

/** The title, editable where it sits: Enter or leaving keeps it, Escape puts it back. */
function TitleField({
  title,
  onDone,
}: {
  readonly title: string;
  readonly onDone: (title: string | null, byKey: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (next: string | null, byKey: boolean) => {
    if (done.current) return;
    done.current = true;
    onDone(next, byKey);
  };

  return (
    <input
      ref={inputRef}
      aria-label="Chat title"
      defaultValue={title}
      maxLength={MAX_TITLE_CHARS}
      spellCheck={false}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") finish(event.currentTarget.value, true);
        if (event.key === "Escape") {
          event.stopPropagation();
          finish(null, true);
        }
      }}
      onBlur={(event) => finish(event.currentTarget.value, false)}
      className={cn(
        ROW_LINE_CLASS_NAME,
        "flex w-full rounded-control bg-background text-ink ring-1 ring-foreground/[0.14] outline-none ring-inset focus:ring-ring/70",
      )}
    />
  );
}
