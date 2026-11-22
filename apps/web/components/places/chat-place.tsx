"use client";

import type { ThreadId } from "@auni/shared";
import { Archive } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useThreads } from "@/components/app/use-threads";
import { Mascot } from "@/components/brand/mascot";
import { Skeleton } from "@/components/ui/skeleton";
import { specialistHref } from "@/lib/app-links";
import type { Thread } from "@/lib/data/views";

import { ChatMenu, useTidyChat } from "./chat-menu";
import { PlaceConversation } from "./place-conversation";
import { PlaceHeader } from "./place-header";

export const CHAT_PLACEHOLDER = "Ask Auni anything";

/** A chat: one conversation outside every specialist, with no money of its own beside it. */
export function ChatPlace({ threadId }: { readonly threadId: ThreadId }) {
  const { loading, threads } = useThreads();
  const thread = threads.find(({ id }) => id === threadId);
  const router = useRouter();
  const specialistId = thread?.specialistId ?? null;

  // A chat that became a specialist is that specialist's conversation now, so it lives on its page.
  useEffect(() => {
    if (specialistId) router.replace(specialistHref(specialistId));
  }, [specialistId, router]);

  if (!thread && !loading) return <MissingPlace what="chat" />;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col">
      {thread ? <title>{`${thread.title} | auni`}</title> : null}
      <PlaceHeader
        icon={null}
        title={thread ? thread.title : <Skeleton className="h-4 w-40 rounded-md" />}
        actions={thread ? <ChatMenu thread={thread} place="header" /> : null}
      />
      {thread?.archived ? <ArchivedNote thread={thread} /> : null}
      <PlaceConversation threadId={threadId} placeholder={CHAT_PLACEHOLDER} />
    </section>
  );
}

/**
 * An archived chat, opened from search: it says so, what brings it back, and offers to now.
 * Writing in it brings it back too, as does Auni's next answer here.
 */
function ArchivedNote({ thread }: { readonly thread: Thread }) {
  const { restore } = useTidyChat(thread);
  return (
    <div className="flex flex-none items-center justify-center gap-3 border-b border-foreground/[0.06] bg-sidebar px-4 py-2.5 text-[13.5px] text-muted-foreground">
      <Archive aria-hidden className="size-4 flex-none text-faint" strokeWidth={1.75} />
      <span className="min-w-0">Archived. It comes back to History when you or Auni write here.</span>
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

/** A link to a place that is gone, or was never this person's. */
export function MissingPlace({ what }: { readonly what: "chat" | "specialist" }) {
  return (
    <section className="flex h-full flex-col items-center justify-center px-6 text-center">
      <Mascot alt="" size={64} state="sad" />
      <p className="mt-4 text-[15px] font-semibold text-ink">This {what} isn&apos;t here</p>
      <Link href="/app" className="auni-text-link mt-2 text-[13.5px]">
        Back to Portfolio
      </Link>
    </section>
  );
}
