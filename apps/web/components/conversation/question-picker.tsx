"use client";

import { Check, CornerDownLeft, X } from "lucide-react";
import { useEffect, useState } from "react";

import { useComposerLead } from "@/components/app/composer";
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
          <p className="text-[15px] leading-[21px] font-semibold tracking-[-0.01em] text-ink">
            {question.question}
          </p>
          {question.multiple ? (
            <p className="mt-0.5 text-[13px] leading-[18px] text-muted-foreground">
              Pick any that fit
            </p>
          ) : null}
        </div>
        {question.multiple ? (
          <button
            type="button"
            disabled={checked.length === 0 || disabled || sent !== null}
            onClick={() => answer(checked)}
            className="h-9 flex-none rounded-full bg-foreground px-4 text-[14px] font-medium text-background transition-[background-color,color,transform] duration-200 ease-settle hover:bg-foreground/85 active:scale-[0.97] disabled:bg-foreground/[0.06] disabled:text-foreground/35 disabled:active:scale-100"
          >
            {checked.length > 1 ? `Send ${checked.length}` : "Send"}
          </button>
        ) : null}
        <button
          type="button"
          aria-label="Close question"
          title="Close (Esc)"
          disabled={sent !== null}
          onClick={onClose}
          className="-mr-1.5 flex size-9 flex-none items-center justify-center rounded-full text-muted-foreground transition-[background-color,color] duration-200 ease-settle outline-none hover:bg-foreground/[0.05] hover:text-ink focus-visible:bg-foreground/[0.05] active:bg-foreground/[0.08] disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <X aria-hidden className="size-4" strokeWidth={2} />
        </button>
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
                  "group/option flex min-h-12 w-full items-center gap-3 rounded-[18px] px-3 py-2 text-left transition-[background-color,opacity] duration-200 ease-settle outline-none hover:bg-foreground/[0.035] focus-visible:bg-foreground/[0.035] active:bg-foreground/[0.06] disabled:hover:bg-transparent",
                  sent !== null && !on && "opacity-40",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex size-[22px] flex-none items-center justify-center rounded-[7px] text-[12px] font-medium tabular-nums transition-colors duration-150",
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
                  <span className="text-[15px] leading-[21px] font-medium tracking-[-0.005em] text-ink">
                    {option.label}
                  </span>
                  {option.hint ? (
                    <span className="text-[13px] leading-[18px] text-muted-foreground">
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
        <button
          key={label}
          type="button"
          disabled={disabled || sent !== null}
          onClick={() => onPick(label)}
          className={cn(
            "flex h-10 max-w-full min-w-0 items-center rounded-full text-[15px] leading-5 tracking-[-0.005em] transition-[background-color,color,opacity,transform] duration-200 ease-settle outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.98] disabled:active:scale-100",
            index === 0
              ? "bg-foreground px-4 font-semibold text-background hover:bg-foreground/85"
              : "px-3 font-medium text-muted-foreground hover:bg-foreground/[0.05] hover:text-ink",
            sent !== null && sent !== label && "opacity-40",
          )}
        >
          <span className="truncate">{label}</span>
        </button>
      ))}
    </div>
  );
}
