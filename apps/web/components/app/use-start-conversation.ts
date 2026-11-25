"use client";

import type { ThreadId } from "@auni/shared";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useState, useTransition, type MouseEvent } from "react";
import { toast } from "sonner";

import { requestComposerFocus } from "@/components/app/composer";
import { useConversationLaunch } from "@/components/app/conversation-launch-context";
import { useCloseMobileThreadMenu } from "@/components/app/mobile-thread-menu";
import { useThreads } from "@/components/app/use-threads";
import { startFailure } from "@/components/app/thread-failure";
import { startInOrder } from "@/components/app/start-in-order";
import { useWelcome } from "@/components/first-run/finish";
import { isModifiedClick } from "@/components/places/open-place";
import { startChat, threadHref, type StartChatOptions } from "@/lib/data/places";
import { threadSession } from "@/lib/data/thread-session";
import type { CarriedTake } from "@/lib/first-message";

/**
 * Something new, typed in a new thread or carried in from first run's landing: the thread starts
 * with the message in it and any picked model and autonomy budget, and the answer streams
 * there. The launch stage holds the words on screen throughout, and a carried take's thread waits
 * for the landing's dive to land in it.
 */
export function useStartConversation() {
  const router = useRouter();
  const pathname = usePathname();
  const { rememberThread } = useThreads();
  const { begin, cancel, continueToThread, launch } = useConversationLaunch();
  const [error, setError] = useState<string | null>(null);
  const [, startNavigation] = useTransition();
  const welcome = useWelcome();
  const start = useCallback(
    async (prompt: string, carried?: CarriedTake, options?: StartChatOptions): Promise<void> => {
      const content = prompt.trim();
      if (!content || launch) return;

      setError(null);
      const composerFromTop =
        pathname === "/app/new" && !carried
          ? (document.querySelector('[data-slot="welcome-composer"] form')?.getBoundingClientRect()
              .top ?? null)
          : null;
      const started = begin(content, carried, composerFromTop);
      if (!started) return;

      // Chosen here, so this tab hears the chat's first turn from before core makes it.
      const threadId = crypto.randomUUID() as ThreadId;
      await startInOrder({
        createChat: async () => {
          const made = await threadSession(threadId, { isNew: true }).start(
            content,
            { id: started.messageId, sentAt: started.startedAt },
            () => startChat({ id: threadId, messageId: started.messageId, text: content }, options),
          );
          return made.thread;
        },
        welcome,
        open: async (thread) => {
          rememberThread(thread);
          continueToThread(started.id, thread);
          const href = threadHref(thread);
          router.prefetch(href);
          await carried?.landed;
          // The blank thread this started from becomes the conversation, so Back skips it;
          // started from anywhere else, Back returns there.
          startNavigation(() =>
            pathname === "/app/new" ? router.replace(href) : router.push(href),
          );
        },
        giveBack: async (failure) => {
          await carried?.landed;
          cancel(started.id);
          // Asked in a new chat's own box, the reason shows under it; asked from elsewhere
          // (search), it goes to a new chat's box, and the reason with it.
          const reason = startFailure(failure);
          if (pathname === "/app/new") setError(reason);
          else {
            toast.error(reason);
            router.push("/app/new");
          }
          // Either way the words are back in that box, never lost to a failed start.
          requestComposerFocus("new", content);
        },
      });
    },
    [begin, cancel, continueToThread, launch, pathname, rememberThread, router, welcome],
  );

  return { busy: launch !== null, error, start } as const;
}

/** The click behind a link to /app/new: a blank thread, its box ready for the next thing. */
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
