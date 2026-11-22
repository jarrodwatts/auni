"use client";

import type { ThreadId } from "@auni/shared";
import { Archive, Eye, Zap } from "lucide-react";
import Link from "next/link";

import { useThreads } from "@/components/app/use-threads";
import { Mascot } from "@/components/brand/mascot";
import { useThreadState } from "@/components/portfolio/use-portfolio";
import { Skeleton } from "@/components/ui/skeleton";
import type { Thread } from "@/lib/data/views";
import { formatUsdcBalance } from "@/lib/money";

import { ChatMenu, useTidyChat } from "./chat-menu";
import { PlaceConversation } from "./place-conversation";
import { PlaceHeader } from "./place-header";

export const CHAT_PLACEHOLDER = "Ask Auni anything";

/** A thread: conversation down the middle, with its on-demand inspector panel on the right. */
export function ChatPlace({ threadId }: { readonly threadId: ThreadId }) {
  const { loading, threads } = useThreads();
  const thread = threads.find(({ id }) => id === threadId);
  const state = useThreadState(thread ? threadId : undefined);

  if (!thread && !loading) return <MissingPlace />;

  const holdings = state.data?.holdings ?? [];
  const totalBaseUnits = holdings.reduce(
    (sum, holding) => sum + BigInt(holding.value.baseUnits),
    0n,
  );
  const auto = thread?.actMode === "within_limits";
  const headerBadge =
    totalBaseUnits > 0n ? (
      <span className="font-semibold text-ink">{formatUsdcBalance(totalBaseUnits)}</span>
    ) : auto ? (
      <span className="flex items-center gap-1 font-medium text-primary">
        <Zap aria-hidden className="size-3.5" />
        Auto
      </span>
    ) : (thread?.watchCount ?? 0) > 0 ? (
      <span className="flex items-center gap-1 text-muted-foreground">
        <Eye aria-hidden className="size-3.5" />
        Watching
      </span>
    ) : undefined;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col">
      {thread ? <title>{`${thread.title} | auni`}</title> : null}
      <PlaceHeader
        icon={null}
        title={thread ? thread.title : <Skeleton className="h-4 w-40 rounded-md" />}
        money={headerBadge}
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
    <div className="flex flex-none items-center justify-center gap-3 border-b border-foreground/[0.06] bg-sidebar px-4 py-2.5 text-[13.5px] text-muted-foreground">
      <Archive aria-hidden className="size-4 flex-none text-faint" strokeWidth={1.75} />
      <span className="min-w-0">Archived. It comes back to Threads when you or Auni write here.</span>
      <button
        type="button"
        onClick={restore}
        className="h-7 flex-none rounded-full bg-background px-3 text-[13px] font-medium text-ink ring-1 ring-foreground/[0.1] transition-colors hover:bg-foreground/[0.04]"
      >
        Bring back
      </button>
    </div>
  );
}

/** A link to a thread that is gone, or was never this person's. */
function MissingPlace() {
  return (
    <section className="flex h-full flex-col items-center justify-center px-6 text-center">
      <Mascot alt="" size={64} state="sad" />
      <p className="mt-4 text-[15px] font-semibold text-ink">This thread isn&apos;t here</p>
      <Link href="/app" className="auni-text-link mt-2 text-[13.5px]">
        Back to Portfolio
      </Link>
    </section>
  );
}
