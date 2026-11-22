"use client";

import type { SpecialistId, ThreadId } from "@auni/shared";
import Link from "next/link";
import type { ComponentProps, MouseEvent } from "react";

import { useCloseMobileThreadMenu } from "@/components/app/mobile-thread-menu";
import { useThreads } from "@/components/app/use-threads";
import { threadSession } from "@/lib/data/thread-session";

export function isModifiedClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
}

/**
 * Every link to a place. Its route is fetched ahead in full, so opening it never waits on the
 * server, and pointing at it reads its conversation, so that is there on arrival too. Tapped in
 * a phone sheet, the sheet closes.
 */
export function PlaceLink({
  specialist,
  thread,
  onClick,
  onPointerEnter,
  ...link
}: ComponentProps<typeof Link> & {
  readonly specialist?: SpecialistId;
  readonly thread?: ThreadId;
}) {
  const closeMobileMenu = useCloseMobileThreadMenu();
  const { threads } = useThreads();
  const conversation =
    thread ?? threads.find(({ specialistId }) => specialistId && specialistId === specialist)?.id;
  return (
    <Link
      prefetch
      {...link}
      onClick={(event) => {
        closeMobileMenu();
        onClick?.(event);
      }}
      onPointerEnter={(event) => {
        const session = conversation ? threadSession(conversation) : null;
        if (session?.read().history === "loading") void session.resync();
        onPointerEnter?.(event);
      }}
    />
  );
}
