"use client";

import { cn } from "@/lib/utils";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { useRouter } from "next/navigation";
import type { ComponentProps } from "react";
import { memo, useMemo } from "react";
import { Streamdown } from "streamdown";

type MessageResponseProps = ComponentProps<typeof Streamdown>;

const streamdownPlugins = { cjk, code, math, mermaid };
/** Soft luminous leading-edge word fade for live streamed prose. */
const STREAM_ANIMATE = {
  animation: "fadeIn",
  duration: 240,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  sep: "word",
  stagger: 22,
} as const;

/** Whether a link in Auni's words goes to a place in this app: a path under /app, on this origin. */
function inApp(link: string): boolean {
  return (
    link.startsWith("/app") &&
    new URL(link, window.location.href).origin === window.location.origin
  );
}

/**
 * How a link in Auni's words opens. One that leaves the app is asked about first, in a box that
 * shows where it goes (Streamdown's own). A place in the app is simply gone to, on this page.
 */
function useLinks(): NonNullable<MessageResponseProps["linkSafety"]> {
  const router = useRouter();
  return useMemo(
    () => ({
      enabled: true,
      // Streamdown calls this before it asks, and opens a new tab on yes or its box on no. A
      // place in the app wants neither, so its answer never comes.
      onLinkCheck: (link) => {
        if (!inApp(link)) return false;
        router.push(link);
        return new Promise<boolean>(() => {});
      },
    }),
    [router],
  );
}

export const MessageResponse = memo(
  function MessageResponse({ className, ...props }: MessageResponseProps) {
    const links = useLinks();
    return (
      <Streamdown
        animated={STREAM_ANIMATE}
        linkSafety={links}
        className={cn(
          "w-full text-pretty [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
          "[&_[data-streamdown=unordered-list]]:ml-1 [&_[data-streamdown=unordered-list]]:list-outside [&_[data-streamdown=unordered-list]]:pl-5",
          "[&_[data-streamdown=ordered-list]]:ml-1 [&_[data-streamdown=ordered-list]]:list-outside [&_[data-streamdown=ordered-list]]:pl-5",
          "[&_[data-streamdown=list-item]]:py-0.5 [&_[data-streamdown=list-item]]:pl-0.5 [&_[data-streamdown=list-item]::marker]:text-muted-foreground/70",
          "[&_[data-streamdown=blockquote]]:rounded-r-xl [&_[data-streamdown=blockquote]]:bg-muted/35 [&_[data-streamdown=blockquote]]:py-2.5 [&_[data-streamdown=blockquote]]:pr-4",
          // A quote's paragraphs stand apart, as they do outside one.
          "[&_[data-streamdown=blockquote]_p+p]:mt-2",
          className,
        )}
        key={props.isAnimating ? "streaming" : "settled"}
        plugins={streamdownPlugins}
        {...props}
      />
    );
  },
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children && nextProps.isAnimating === prevProps.isAnimating,
);
