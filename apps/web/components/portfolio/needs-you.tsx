"use client";

import type { ThreadId } from "@auni/shared";
import { ArrowRight, MessageCircle } from "lucide-react";

import { PlaceLink } from "@/components/places/open-place";
import type { ChatPlace } from "@/components/places/use-places";
import { chatHref } from "@/lib/app-links";

import { PortfolioSection } from "./portfolio-section";

/**
 * The decisions waiting on the person, and nothing else: one row per thread
 * with a card still waiting, saying what it asks. Usually empty, and then the
 * section is gone.
 */
export function NeedsYou({
  chats,
  className,
}: {
  readonly chats: readonly ChatPlace[];
  readonly className?: string;
}) {
  const waiting = chats.filter((chat) => chat.waiting);
  if (waiting.length === 0) return null;
  return (
    <PortfolioSection title="Needs you" className={className}>
      <ul className="overflow-hidden rounded-card border border-foreground/[0.08] sm:grid sm:grid-cols-2 sm:gap-3 sm:overflow-visible sm:rounded-none sm:border-0">
        {waiting.map(({ thread }) => (
          <NeedsYouRow
            key={thread.id}
            href={chatHref(thread.id)}
            thread={thread.id}
            name={thread.title}
            ask={thread.moneyLine}
          />
        ))}
      </ul>
    </PortfolioSection>
  );
}

function NeedsYouRow({
  href,
  thread,
  name,
  ask,
}: {
  readonly href: string;
  readonly thread: ThreadId;
  readonly name: string;
  readonly ask: string | null | undefined;
}) {
  return (
    <li className="relative min-w-0 not-first:before:absolute not-first:before:top-0 not-first:before:right-0 not-first:before:left-[62px] not-first:before:h-px not-first:before:bg-foreground/[0.06] sm:not-first:before:hidden">
      <PlaceLink
        href={href}
        thread={thread}
        className="group flex items-center gap-3 bg-card py-3 pr-3 pl-3.5 transition-colors duration-200 ease-settle hover:bg-foreground/[0.02] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none focus-visible:ring-inset sm:rounded-card sm:border sm:border-foreground/[0.08]"
      >
        <span className="flex size-9 flex-none items-center justify-center rounded-full bg-surface">
          <MessageCircle aria-hidden className="size-4 text-muted-foreground" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui font-medium text-ink">{name}</span>
          <span className="mt-0.5 block truncate text-meta text-muted-foreground">
            {ask ?? "Waiting for your OK"}
          </span>
        </span>
        <span className="flex h-8 flex-none items-center gap-1 rounded-full bg-foreground pr-3 pl-3.5 text-meta font-semibold text-background transition-[background-color,scale] duration-200 ease-settle group-hover:bg-foreground/85 group-active:scale-[0.97]">
          Review
          <ArrowRight
            aria-hidden
            className="size-3.5 transition-transform duration-300 ease-settle group-hover:translate-x-[3px] motion-reduce:transition-none motion-reduce:group-hover:translate-x-0"
            strokeWidth={2.4}
          />
        </span>
      </PlaceLink>
    </li>
  );
}
