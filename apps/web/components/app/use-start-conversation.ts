"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useState, useTransition, type MouseEvent } from "react";
import { toast } from "sonner";

import { requestComposerFocus } from "@/components/app/composer";
import { useConversationLaunch } from "@/components/app/conversation-launch-context";
import { useCloseMobileThreadMenu } from "@/components/app/mobile-thread-menu";
import { useThreads } from "@/components/app/use-threads";
import { START_FAILURE } from "@/components/app/thread-failure";
import { isModifiedClick } from "@/components/places/open-place";
import { startChat, threadHref } from "@/lib/data/places";
import { threadSession } from "@/lib/data/thread-session";
import type { CarriedTake } from "@/lib/first-message";

/**
 * Something new, typed in a new chat or carried in from first run's landing: the chat starts,
 * the message carries into it, and the answer streams there. The launch stage holds the words
 * on screen throughout, and a carried take's chat waits for the landing's dive to land in it.
 */
export function useStartConversation() {
  const router = useRouter();
  const pathname = usePathname();
  const { rememberThread } = useThreads();
  const { begin, cancel, continueToThread, launch } = useConversationLaunch();
  const [error, setError] = useState<string | null>(null);
  const [, startNavigation] = useTransition();
  const start = useCallback(
    async (prompt: string, carried?: CarriedTake): Promise<void> => {
      const content = prompt.trim();
      if (!content || launch) return;

      setError(null);
      const started = begin(content, carried);
      if (!started) return;

      try {
        const thread = await startChat(content);
        rememberThread(thread);
        continueToThread(started.id, thread);
        // The tab's session sends it, so navigating can't cut it off.
        void threadSession(thread.id, { isNew: true }).send(content, {
          id: started.messageId,
          sentAt: started.startedAt,
        });
        const href = threadHref(thread);
        router.prefetch(href);
        await carried?.landed;
        // The blank chat this started from becomes the conversation, so Back skips it;
        // started from anywhere else, Back returns there.
        startNavigation(() => (pathname === "/app/new" ? router.replace(href) : router.push(href)));
      } catch {
        await carried?.landed;
        cancel(started.id);
        // Asked in the new chat's own box: the reason shows under it.
        if (pathname === "/app/new") {
          setError(START_FAILURE);
          return;
        }
        // Asked from elsewhere (search), so the words go into the new chat's box with the reason.
        toast.error(START_FAILURE);
        if (pathname !== "/app/new") router.push("/app/new");
        requestComposerFocus("new", content);
      }
    },
    [begin, cancel, continueToThread, launch, pathname, rememberThread, router],
  );

  return { busy: launch !== null, error, start } as const;
}

/** The click behind a link to /app/new: a blank chat, its box ready for the next thing. */
export function useStartNew() {
  const closeMobileMenu = useCloseMobileThreadMenu();
  return useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      closeMobileMenu();
      if (!isModifiedClick(event)) requestComposerFocus("new");
    },
    [closeMobileMenu],
  );
}
