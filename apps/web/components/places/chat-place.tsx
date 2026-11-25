"use client";

import type { ThreadId } from "@auni/shared";
import type { AutomationWire } from "@auni/shared";
import { Archive, Eye, Zap } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { useThreads } from "@/components/app/use-threads";
import { Mascot } from "@/components/brand/mascot";
import { useThreadState } from "@/components/portfolio/use-portfolio";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { liveWatches, useWatches } from "@/components/watching/use-watches";
import type { Thread, ThreadState } from "@/lib/data/views";
import { formatUsd } from "@/lib/money";
import { cn } from "@/lib/utils";

import { ChatMenu, useTidyChat } from "./chat-menu";
import { PlaceConversation } from "./place-conversation";
import { PlaceHeader } from "./place-header";
import { TakeFigures } from "./place-marks";
import { takeValue } from "./use-takes";

export const CHAT_PLACEHOLDER = "Ask Auni anything";

/** A chat: the conversation down the middle, with its inspector on the right when wanted. */
export function ChatPlace({ threadId }: { readonly threadId: ThreadId }) {
  const { loading, threads } = useThreads();
  const thread = threads.find(({ id }) => id === threadId);
  const state = useThreadState(thread ? threadId : undefined);
  const [watch] = liveWatches(useWatches({ threadId }).data ?? []);

  if (!thread && !loading) return <MissingPlace />;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col">
      {thread ? <title>{`${thread.title} | auni`}</title> : null}
      <PlaceHeader
        icon={null}
        title={thread ? thread.title : <Skeleton className="h-4 w-40 rounded-control" />}
        money={thread ? headerFigures(thread, state.data, watch) : undefined}
        pane={thread !== undefined}
        actions={thread ? <ChatMenu thread={thread} place="header" /> : null}
      />
      {thread?.archived ? <ArchivedNote thread={thread} /> : null}
      <PlaceConversation threadId={threadId} placeholder={CHAT_PLACEHOLDER} />
    </section>
  );
}

/**
 * An archived thread, opened from search: it says so, what brings it back, and offers to now.
 * Writing in it brings it back too, as does Auni's next answer here.
 */
function ArchivedNote({ thread }: { readonly thread: Thread }) {
  const { restore } = useTidyChat(thread);
  return (
    <div className="flex flex-none items-center justify-center gap-3 border-b border-foreground/[0.06] bg-sidebar px-4 py-2.5 text-ui text-muted-foreground">
      <Archive aria-hidden className="size-4 flex-none text-faint" strokeWidth={1.75} />
      <span className="min-w-0">Archived. It comes back when you or Auni write here.</span>
      <Button variant="outline" size="sm" onClick={restore} className="flex-none">
        Restore
      </Button>
    </div>
  );
}

/** A link to a chat that is gone, or was never this owner's. */
function MissingPlace() {
  return (
    <section className="flex h-full flex-col items-center justify-center px-6 text-center">
      <Mascot alt="" size={64} state="sad" />
      <p className="mt-4 text-body font-semibold text-ink">This chat isn&apos;t here</p>
      <p className="mt-1 text-ui text-muted-foreground">It may have been deleted.</p>
      <Link href="/app/new" className="auni-text-link mt-3 text-ui">
        Start a new take
      </Link>
    </section>
  );
}

/**
 * What the header says of a chat, and the way into its inspector: what its take is worth and how
 * that moved today, then what Auto has left to spend, or, holding nothing, what it watches.
 */
function headerFigures(
  thread: Thread,
  state: ThreadState | undefined,
  watch: AutomationWire | undefined,
): ReactNode {
  const take = takeValue(state?.holdings ?? []);
  const auto = thread.actMode === "within_limits";
  if (!take && !auto && !watch) return undefined;
  return (
    <>
      {take ? <TakeFigures take={take} layout="inline" /> : null}
      {auto ? (
        <span className={cn("flex items-center gap-1 text-primary", take && "max-sm:hidden")}>
          <Zap aria-hidden className="size-3.5" />
          Auto: {formatUsd(state?.freeBudgetUsd ?? thread.budgetUsd)} left
        </span>
      ) : null}
      {!take && !auto && watch ? (
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
          <Eye aria-hidden className="size-3.5 flex-none" />
          <span className="max-w-[220px] truncate max-sm:max-w-[140px]">{watch.description}</span>
        </span>
      ) : null}
    </>
  );
}
