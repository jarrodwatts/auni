"use client";

import { Check, CornerDownLeft, X } from "lucide-react";
import { useEffect, useState } from "react";

import { useComposerLead } from "@/components/app/composer";
import { Button } from "@/components/ui/button";
import { joinPicks, type AuniQuestion } from "@/lib/conversation";
import { cn } from "@/lib/utils";

/** Keys typed into a field are words, never picks. */
function typingInField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest("input, textarea, select") !== null)
  );
}

/**
 * Auni's open question, docked at the head of the reply box: its answers
 * stacked under it, each a tap or its number key away. A question that takes
 * several answers checks them instead, and Send takes them together. The
 * words below stay the way to say something else, and closing it (or Esc)
 * leaves only them.
 *
 * Replies offered with no question are the next things the owner might say,
 * so they take one line, not a list: the first as the main button, the rest
 * as quiet words beside it (see NextReplies).
 */
export function QuestionPicker({
  question,
  onClose,
}: {
  readonly question: AuniQuestion;
  readonly onClose: () => void;
}) {
  const { disabled, send } = useComposerLead();
  const [checked, setChecked] = useState<readonly string[]>([]);
  const [sent, setSent] = useState<readonly string[] | null>(null);

  const answer = (labels: readonly string[]) => {
    if (labels.length === 0 || disabled || sent) return;
    setSent(labels);
    // Picks join in the question's own order, however they were tapped.
    send(
      joinPicks(
        question.options.map(({ label }) => label).filter((label) => labels.includes(label)),
      ),
    );
  };
  const toggle = (label: string) =>
    setChecked((current) =>
      current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label],
    );
  const choose = (label: string) => (question.multiple ? toggle(label) : answer([label]));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typingInField(event.target)) return;
      // A dialog over the thread takes its own Esc.
      if (event.key === "Escape" && !event.defaultPrevented) {
        onClose();
        return;
      }
      const option = question.options[Number(event.key) - 1];
      if (!option) return;
      event.preventDefault();
      choose(option.label);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (question.question === null)
    return (
      <NextReplies
        options={question.options.map(({ label }) => label)}
        disabled={disabled}
        sent={sent?.[0] ?? null}
        onPick={(label) => answer([label])}
      />
    );

  return (
    <div className="auni-stagger-in" role="group" aria-label={question.question}>
      <div className="flex items-start gap-3 px-3.5 pt-2.5 pb-2">
        <div className="min-w-0 flex-1 pt-1">
          <p className="text-body leading-[21px] font-semibold tracking-[-0.01em] text-ink">
            {question.question}
          </p>
          {question.multiple ? (
            <p className="mt-0.5 text-meta leading-[18px] text-muted-foreground">
              Pick any that fit
            </p>
          ) : null}
        </div>
        {question.multiple ? (
          <Button
            type="button"
            disabled={checked.length === 0 || disabled || sent !== null}
            onClick={() => answer(checked)}
          >
            {checked.length > 1 ? `Send ${checked.length}` : "Send"}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Close question"
          title="Close (Esc)"
          disabled={sent !== null}
          onClick={onClose}
          className="-mr-1.5"
        >
          <X aria-hidden className="size-4" strokeWidth={2} />
        </Button>
      </div>
      {/* Capped, so on a phone the answer it asks about stays readable above. */}
      <ul className="flex max-h-[34dvh] flex-col overflow-y-auto overscroll-contain px-0.5">
        {question.options.map((option, index) => {
          const on = (question.multiple ? checked : (sent ?? [])).includes(option.label);
          return (
            <li
              key={option.label}
              className="auni-stagger-in"
              style={{ animationDelay: `${60 + index * 40}ms` }}
            >
              <button
                type="button"
                aria-pressed={question.multiple ? on : undefined}
                disabled={disabled || sent !== null}
                onClick={() => choose(option.label)}
                className={cn(
                  "group/option flex min-h-12 w-full items-center gap-3 rounded-card px-3 py-2 text-left transition-[background-color,opacity] duration-200 ease-settle focus-ring-inset hover:bg-foreground/[0.035] active:bg-foreground/[0.06] disabled:hover:bg-transparent",
                  sent !== null && !on && "opacity-40",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-[22px] flex-none items-center justify-center rounded-control text-caption font-medium transition-colors duration-150 tabular-nums",
                    on
                      ? "bg-foreground text-background"
                      : question.multiple
                        ? "border border-foreground/[0.16] bg-background"
                        : "bg-foreground/[0.05] text-muted-foreground group-hover/option:bg-foreground/[0.08] group-hover/option:text-ink",
                  )}
                >
                  {on ? (
                    <Check className="size-3.5" strokeWidth={2.5} />
                  ) : question.multiple ? null : (
                    index + 1
                  )}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-body leading-[21px] font-medium tracking-[-0.005em] text-ink">
                    {option.label}
                  </span>
                  {option.hint ? (
                    <span className="text-meta leading-[18px] text-muted-foreground">
                      {option.hint}
                    </span>
                  ) : null}
                </span>
                {question.multiple ? null : (
                  <CornerDownLeft
                    aria-hidden
                    className="size-4 flex-none text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/option:opacity-100 pointer-coarse:hidden"
                    strokeWidth={1.75}
                  />
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <div aria-hidden className="mx-3.5 mt-1.5 mb-0.5 h-px bg-foreground/[0.06]" />
    </div>
  );
}

/**
 * Replies offered with no question: one line at the head of the reply box. The first is what
 * Auni would say next in the owner's place, as the main button; any other is a quiet word
 * beside it. Number keys pick as they do for a question, and Esc closes it; it is too small to
 * need a button for that.
 */
function NextReplies({
  options,
  disabled,
  sent,
  onPick,
}: {
  readonly options: readonly string[];
  readonly disabled: boolean;
  readonly sent: string | null;
  readonly onPick: (label: string) => void;
}) {
  return (
    <div
      className="auni-stagger-in flex flex-wrap items-center gap-x-0.5 gap-y-1.5 px-1.5 pt-1.5 pb-1"
      role="group"
      aria-label="Suggested replies"
    >
      {options.map((label, index) => (
        <Button
          key={label}
          type="button"
          variant={index === 0 ? "primary" : "ghost"}
          disabled={disabled || sent !== null}
          onClick={() => onPick(label)}
          className={cn(
            "max-w-full min-w-0 shrink",
            index === 0 ? "font-semibold" : "px-3",
            // The one picked stays as it was; the rest step back.
            sent !== null && (sent === label ? "disabled:opacity-100" : "disabled:opacity-40"),
          )}
        >
          <span className="truncate">{label}</span>
        </Button>
      ))}
    </div>
  );
}
