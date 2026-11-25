"use client";

import { feedbackPost, feedbackSearchUrl, type Feedback } from "@auni/shared";
import { ArrowUpRight, Check, ChevronDown } from "lucide-react";
import { useState } from "react";

import { MoneyButton } from "@/components/cards/money/money-card-parts";
import { AutoHeight } from "@/components/motion/auto-height";
import { useClipboardCopy } from "@/lib/use-clipboard-copy";
import { cn } from "@/lib/utils";

/**
 * What a piece of feedback would post, and the one button that opens GitHub's form with it
 * filled in. Nothing is sent from here: the owner posts it themselves, from their own GitHub
 * account, and can change it there first. Whatever could point at their wallet is a tick they
 * make, off until they do, with what it would show said beside it and its exact words a tap
 * away. A card in the chat and a report the owner starts themselves share it.
 */
export function FeedbackBody({
  feedback,
  onOpened,
}: {
  readonly feedback: Feedback;
  /** Told once GitHub's form has been opened in the browser. */
  readonly onOpened?: () => void;
}) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState(false);
  const clipboard = useClipboardCopy();
  const post = feedbackPost(feedback, ticked);
  const flip =
    (set: (change: (before: ReadonlySet<string>) => Set<string>) => void) => (field: string) =>
      set((before) => {
        const next = new Set(before);
        if (!next.delete(field)) next.add(field);
        return next;
      });
  const tick = flip(setTicked);
  const show = flip(setShown);
  const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");
  const copied = clipboard.copiedValue === post.text;
  // The title already says a part that is its own last words (an idea, what happened).
  const rows = feedback.always.filter(({ value }) => !feedback.title.endsWith(value));

  return (
    <div className="@container" data-testid="feedback" data-kind={feedback.kind}>
      {/* The note itself, as it would read on GitHub: its title, then each thing it says. */}
      <div className="rounded-card bg-foreground/[0.035] px-4 pt-3.5 pb-4">
        <p className="text-caption leading-4 font-medium text-faint">What will be posted</p>
        <p className="mt-1.5 text-reading leading-[22px] font-semibold tracking-[-0.015em] text-pretty text-ink">
          {feedback.title}
        </p>
        {rows.length > 0 ? (
          <dl className="mt-3 flex flex-col gap-2 border-t border-foreground/[0.06] pt-3">
            {rows.map((part) => (
              <div
                key={part.field}
                className="grid grid-cols-[minmax(0,5fr)_minmax(0,8fr)] gap-x-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,5fr)]"
              >
                <dt className="pt-px text-meta leading-5 text-muted-foreground">{part.label}</dt>
                <dd className="min-w-0 text-body leading-5 text-pretty text-ink wrap-anywhere">
                  {part.reads ?? part.value}
                  {/* The owner's words first; what is posted is the maintainers' name for it. */}
                  {part.reads ? (
                    <span className="block text-meta leading-[18px] text-muted-foreground">
                      Posted as {part.value}
                    </span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
      {feedback.optional.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-2">
          {feedback.optional.map((part) => {
            const on = ticked.has(part.field);
            const seen = shown.has(part.field);
            return (
              <li
                key={part.field}
                className={cn(
                  "rounded-card border transition-[background-color,border-color] duration-200 ease-settle",
                  on
                    ? "border-foreground/[0.14] bg-card"
                    : "border-transparent bg-foreground/[0.035]",
                )}
              >
                <AutoHeight>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={on}
                    onClick={() => tick(part.field)}
                    className="flex w-full items-start gap-3 rounded-card px-3.5 pt-3 pb-1.5 text-left focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "mt-px flex size-5 flex-none items-center justify-center rounded-control border transition-colors duration-200 ease-settle",
                        on
                          ? "border-foreground bg-foreground text-background"
                          : "border-foreground/[0.22] bg-background",
                      )}
                    >
                      {on ? <Check className="size-3" strokeWidth={3.2} /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-body leading-5 font-medium text-ink">
                        Also post {lowerFirst(part.label)}
                      </span>
                      <span className="mt-0.5 block text-meta leading-[18px] text-muted-foreground">
                        {part.warning}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-expanded={seen}
                    onClick={() => show(part.field)}
                    className="mb-2 ml-[46px] flex h-7 items-center gap-1 rounded-full text-meta font-medium text-muted-foreground transition-colors hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none"
                  >
                    {seen ? "Hide it" : "See exactly what it posts"}
                    <ChevronDown
                      aria-hidden
                      className={cn(
                        "size-3.5 transition-transform duration-200",
                        seen && "rotate-180",
                      )}
                      strokeWidth={2.2}
                    />
                  </button>
                  {seen ? (
                    <p className="mr-3.5 mb-3 ml-[46px] rounded-control bg-foreground/[0.04] px-3 py-2.5 text-meta leading-[19px] whitespace-pre-wrap text-ink wrap-anywhere">
                      {part.value}
                    </p>
                  ) : null}
                </AutoHeight>
              </li>
            );
          })}
        </ul>
      ) : null}
      <p className="mt-4 text-meta leading-[1.45] text-muted-foreground">
        {opened
          ? "GitHub's form is open in your browser with this filled in. Press Submit there to post it."
          : "This opens GitHub's form in your browser with this filled in, under your own account. Auni sends nothing, and you can change it there before you post."}
        {post.cut ? " It is too long to fill in whole, so the form gets a shorter copy." : null}
      </p>
      <div className="mt-4 flex flex-col gap-x-4 gap-y-3 @xl:flex-row-reverse @xl:items-center">
        <MoneyButton
          className="w-full @xl:w-auto @xl:flex-none @xl:px-6"
          tone="primary"
          onClick={() => {
            open(post.url);
            setOpened(true);
            onOpened?.();
          }}
        >
          {opened ? "Open it again" : "Open on GitHub"}
          <ArrowUpRight aria-hidden className="size-4" strokeWidth={2.4} />
        </MoneyButton>
        <p className="flex min-w-0 flex-1 flex-wrap justify-center gap-x-5 gap-y-1 text-meta leading-5 @xl:justify-start">
          <button
            type="button"
            className={QUIET_LINK}
            onClick={() => open(feedbackSearchUrl(feedback))}
          >
            See if someone already asked
          </button>
          <button type="button" className={QUIET_LINK} onClick={() => clipboard.copy(post.text)}>
            {copied ? "Copied" : "Copy all of it"}
          </button>
        </p>
      </div>
      {clipboard.blocked ? (
        <p
          role="alert"
          className="mt-1.5 text-center text-meta text-muted-foreground @xl:text-left"
        >
          Copying was blocked, so GitHub&apos;s form is the way to post it.
        </p>
      ) : null}
    </div>
  );
}

const QUIET_LINK =
  "font-medium text-muted-foreground underline decoration-foreground/20 underline-offset-2 transition-colors hover:text-ink hover:decoration-foreground/50";

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
