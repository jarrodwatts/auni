"use client";

import "./chat-row.css";

import { Eye, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Thread } from "@/lib/data/views";
import { cn } from "@/lib/utils";

import type { ChatStatus } from "./attention";
import { ChatMenu, MAX_TITLE_CHARS, useTidyChat } from "./chat-menu";
import { useLongPress } from "./long-press";
import { PlaceLink } from "./open-place";
import { ATTENTION_LABEL, ChatStatusMark } from "./place-marks";
import { ROW_ACTIVE_CLASS_NAME, ROW_CLASS_NAME, ROW_LINE_CLASS_NAME } from "./sidebar-rows";

const REVEAL_ACTIONS =
  "group-hover/chat:opacity-100 group-hover/chat:pointer-events-auto group-focus-within/chat:opacity-100 group-focus-within/chat:pointer-events-auto group-data-menu/chat:opacity-100 group-data-menu/chat:pointer-events-auto pointer-coarse:group-data-active/chat:opacity-100 pointer-coarse:group-data-active/chat:pointer-events-auto";

const MAKE_ROOM =
  "group-hover/chat:pr-10 group-focus-within/chat:pr-10 group-data-menu/chat:pr-10 pointer-coarse:group-data-active/chat:pr-12";
const STEP_ASIDE =
  "group-hover/chat:hidden group-focus-within/chat:hidden group-data-menu/chat:hidden pointer-coarse:group-data-active/chat:hidden";

const WORKING_TITLE =
  "shimmer shimmer-color-ink/50 motion-reduce:shimmer-none motion-reduce:text-muted-foreground";

/**
 * One thread row in the sidebar: title, subtle active badge (Your turn, money
 * ring, Auto zap, or Watching eye), and inline rename / pin / archive / delete.
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

  const auto = thread.actMode === "within_limits";
  const watching = thread.watchCount > 0;

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
            {status.mark ? (
              <ChatStatusMark mark={status.mark} className={STEP_ASIDE} />
            ) : auto ? (
              <span
                title="Auto within budget"
                className={cn("flex flex-none items-center text-primary", STEP_ASIDE)}
              >
                <Zap aria-hidden className="size-3.5" />
                <span className="sr-only">Auto within budget</span>
              </span>
            ) : watching ? (
              <span
                title="Watching"
                className={cn("flex flex-none items-center text-faint", STEP_ASIDE)}
              >
                <Eye aria-hidden className="size-3.5" />
                <span className="sr-only">Watching</span>
              </span>
            ) : null}
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
      aria-label="Thread title"
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
