"use client";

import { MAXIMUM_MESSAGE_CHARACTERS } from "@auni/shared";
import { ArrowUp, LoaderCircle, Square } from "lucide-react";
import {
  createContext,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { ApprovalModeChip } from "@/components/app/approval-mode-chip";
import { useComposerCaret } from "@/components/app/composer-caret";
import { useComposerDraft } from "@/components/app/composer-drafts";
import {
  COMPOSER_INPUT_CLASS_NAME,
  COMPOSER_SURFACE_CLASS_NAME,
  ComposerLoadingLayout,
  type ComposerLoadingPhase,
} from "@/components/app/composer-shell";
import type { MascotReadingTarget } from "@/components/brand/interactive-mascot";
import { cn } from "@/lib/utils";

const COMPOSER_MAX_HEIGHT_PX = 160;
/** The text box's height on one line: 24px of words in 8px of padding. */
const ONE_LINE_PX = 40;

function resizeComposerDraft(input: HTMLTextAreaElement): void {
  input.style.height = "0px";
  input.style.height = `${Math.min(input.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
}

/** A tap anywhere on the pill that isn't a control puts the cursor at the end of the draft. */
function focusDraftFromTap(target: EventTarget, input: HTMLTextAreaElement | null): void {
  if (!input || !(target instanceof Element)) return;
  if (target.closest('a, button, input, select, textarea, [role="button"]')) return;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

let focusRequest: { readonly draftKey: string; readonly text: string } | null = null;
const focusListeners = new Set<() => void>();

/** Focuses the composer with this draft key, now or as soon as it's on screen, with `text` if it's empty. */
export function requestComposerFocus(draftKey: string, text = ""): void {
  focusRequest = { draftKey, text };
  for (const listener of focusListeners) listener();
}

/** What a docked lead (a question Auni is asking) can do with the reply box it sits in. */
interface ComposerLeadControls {
  /** Sends these words as the person's message, leaving any typed draft alone. */
  readonly send: (text: string) => void;
  readonly disabled: boolean;
}

const ComposerLeadContext = createContext<ComposerLeadControls | null>(null);

/** The reply box a docked lead sits in; only valid inside the composer's `lead`. */
export function useComposerLead(): ComposerLeadControls {
  const controls = use(ComposerLeadContext);
  if (!controls) throw new Error("useComposerLead is only for a composer's lead");
  return controls;
}

interface ComposerProps {
  readonly autoFocus?: boolean;
  readonly busy?: boolean;
  readonly disabled?: boolean;
  /** Persists the draft in sessionStorage under this key so remounts keep it. */
  readonly draftKey?: string;
  readonly initialMessage?: string;
  /** Docked above the words, inside the same enclosure: a question waiting on the person. */
  readonly lead?: ReactNode;
  readonly loadingPhase?: ComposerLoadingPhase;
  readonly placeholder: string;
  readonly onCaretActivity?: (target: MascotReadingTarget) => void;
  readonly onStop?: () => void;
  readonly onSubmit: (message: string) => void | Promise<void>;
}

export function Composer({
  autoFocus = false,
  busy = false,
  disabled = false,
  draftKey,
  initialMessage = "",
  lead,
  loadingPhase = "ready",
  onCaretActivity,
  onStop,
  onSubmit,
  placeholder,
}: ComposerProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composerInteractive = loadingPhase === "ready";
  const interactionDisabled = disabled || !composerInteractive;

  const { clearForSend, message, setMessage } = useComposerDraft({
    draftKey,
    initialMessage,
    interactive: composerInteractive,
  });

  useComposerCaret(inputRef, message, onCaretActivity);

  useEffect(() => {
    if (!autoFocus || interactionDisabled) return;
    // On a phone the keyboard would cover the answer; it opens for words handed back to edit.
    if (!initialMessage && matchMedia("(pointer: coarse)").matches) return;
    const frame = requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(initialMessage.length, initialMessage.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, initialMessage, interactionDisabled]);

  useEffect(() => {
    if (!draftKey || interactionDisabled) return;
    const take = () => {
      const input = inputRef.current;
      if (!input || focusRequest?.draftKey !== draftKey) return;
      const { text } = focusRequest;
      focusRequest = null;
      if (text) setMessage((current) => current || text);
      input.focus();
    };
    take();
    focusListeners.add(take);
    return () => {
      focusListeners.delete(take);
    };
  }, [draftKey, interactionDisabled, setMessage]);

  // One line at rest. Once the words need a second, they take the pill's
  // whole width with the chip and send on a row beneath, until it empties.
  // Read from layout and written straight to the row, so typing never re-renders for it.
  const rowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const input = inputRef.current;
    const row = rowRef.current;
    if (!input || !row) return;
    resizeComposerDraft(input);
    const wrapped =
      message !== "" && ("wrapped" in row.dataset || input.scrollHeight > ONE_LINE_PX);
    if (wrapped === "wrapped" in row.dataset) return;
    row.toggleAttribute("data-wrapped", wrapped);
    resizeComposerDraft(input);
  }, [message]);

  const canSend = (!busy || Boolean(onStop)) && !interactionDisabled;
  const showStop = busy && Boolean(onStop) && message.trim().length === 0;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = message.trim();
    if (!content || !canSend) return;
    // The draft ends before the send: a success remounts this composer under a
    // new key, and the fresh mount must not adopt the words just sent.
    clearForSend();
    await onSubmit(content);
  };

  const leadControls: ComposerLeadControls = {
    send: (text) => {
      if (canSend && text.trim()) void onSubmit(text.trim());
    },
    disabled: interactionDisabled || !canSend,
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  return (
    <form
      aria-busy={!composerInteractive}
      data-loading-phase={loadingPhase}
      className={cn(
        COMPOSER_SURFACE_CLASS_NAME,
        // Glows for typing only: tapping a docked answer is not writing.
        "transition-shadow duration-300 ease-settle has-[textarea:focus]:shadow-[0_10px_30px_--alpha(var(--color-primary)/12%),0_0_0_1px_--alpha(var(--color-primary)/24%)] motion-reduce:transition-none",
      )}
      onClick={(event) => {
        if (!interactionDisabled) focusDraftFromTap(event.target, inputRef.current);
      }}
      onSubmit={(event) => void submit(event)}
    >
      {lead ? <ComposerLeadContext value={leadControls}>{lead}</ComposerLeadContext> : null}
      <div
        ref={rowRef}
        className="auni-composer-live grid grid-cols-[auto_minmax(0,1fr)_auto] items-end gap-x-1 [grid-template-areas:'chip_text_send'] data-wrapped:[grid-template-areas:'text_text_text'_'chip_._send']"
        data-phase={loadingPhase}
        inert={!composerInteractive}
      >
        <div className="flex h-10 items-center [grid-area:chip]">
          <ApprovalModeChip />
        </div>
        <label className="sr-only" htmlFor="auni-message">
          Message Auni
        </label>
        <textarea
          id="auni-message"
          ref={inputRef}
          rows={1}
          value={message}
          maxLength={MAXIMUM_MESSAGE_CHARACTERS}
          onChange={(event) => {
            setMessage(event.target.value);
            resizeComposerDraft(event.currentTarget);
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={interactionDisabled}
          autoComplete="off"
          className={cn(
            COMPOSER_INPUT_CLASS_NAME,
            "overflow-y-auto [grid-area:text] disabled:cursor-not-allowed disabled:opacity-60",
          )}
        />
        {/* Send: a 36px disc in a 40px target, quiet grey until there is something to send, then black. */}
        <button
          className="group/submit flex size-10 flex-none items-center justify-center rounded-full text-background outline-none [grid-area:send] active:scale-95 disabled:cursor-not-allowed disabled:active:scale-100"
          type={showStop ? "button" : "submit"}
          aria-label={
            showStop ? "Stop response" : busy && !onStop ? "Auni is responding" : "Send message"
          }
          disabled={interactionDisabled || (!showStop && (!canSend || message.trim().length === 0))}
          onClick={showStop ? onStop : undefined}
        >
          <span className="pointer-events-none flex size-9 items-center justify-center rounded-full bg-foreground transition-[background-color,color] duration-200 ease-settle group-hover/submit:bg-foreground/85 group-focus-visible/submit:ring-[3px] group-focus-visible/submit:ring-ring/50 group-disabled/submit:bg-foreground/[0.07] group-disabled/submit:text-foreground/35">
            {showStop ? (
              <Square className="size-3 fill-current" aria-hidden />
            ) : busy && !onStop ? (
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
            ) : (
              <ArrowUp className="size-4" aria-hidden />
            )}
          </span>
        </button>
      </div>
      {loadingPhase !== "ready" ? (
        // The veil captures typing while the live row is still hidden; the
        // draft hook adopts it the moment the composer is real.
        <ComposerLoadingLayout
          capture
          className="absolute inset-1.5"
          label="Draft your message"
          placeholder=""
        />
      ) : null}
    </form>
  );
}
