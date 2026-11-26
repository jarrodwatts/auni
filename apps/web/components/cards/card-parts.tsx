"use client";

import { LoaderCircle } from "lucide-react";
import { useState, type ReactNode } from "react";

import { EDGE_SIZE, EdgeMascot } from "@/components/brand/edge-mascot";
import { headroom, wantsAuni, type EdgeScene } from "@/components/brand/edge-pose";
import { AutoHeight } from "@/components/motion/auto-height";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import styles from "./money/money-card.module.css";
import { useNewestCard } from "./money/use-newest-card";

/**
 * Every card Auni draws in a conversation has one anatomy, whatever it is about:
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ [mark]  What it is                 $250      │  CardHead: what, and how much
 *   │         where, or where it stands  to buy    │
 *   │ ──────────────────────────────────────────── │
 *   │ the body: what changes hands, and its facts  │
 *   │                                              │
 *   │ [Decline]  [        Buy $250        ]        │  CardActions: the verb, with its amount
 *   └──────────────────────────────────────────────┘
 *
 * It is one object that changes in place: while it waits on the owner its edge is amber and
 * Auni peeks over it; once tapped it works, then settles into a one-line receipt (CardReceipt)
 * in the same frame, easing to its new height.
 */
export type CardTone = "waiting" | "warning" | "failed" | null;

export function CardFrame({
  auni = null,
  children,
  label,
  phase,
  tone = null,
}: {
  /**
   * What Auni, peeking over the card's top edge, makes of it; null where it has nothing to
   * watch. It comes only to the newest card that wants it, never to one already settled when it
   * first showed, and once a card has settled and Auni has left it for a newer one, never back.
   */
  readonly auni?: EdgeScene | null;
  readonly children: ReactNode;
  readonly label: string;
  readonly phase: "open" | "confirmed" | "expired";
  /**
   * Its edge: amber while it waits on the owner, or warns them of something they didn't ask for
   * (a liquidation); red once it failed; else a hairline.
   */
  readonly tone?: CardTone;
}) {
  const settled = phase === "confirmed" || phase === "expired";
  // Only a change of phase animates; a card drawn from history is simply there.
  const [firstPhase] = useState(phase);
  const [card, setCard] = useState<HTMLElement | null>(null);
  // The first state Auni sees a card in says whether to keep it company, or leave it as history.
  const [first, setFirst] = useState<EdgeScene | null>(null);
  if (first === null && auni) setFirst(auni);
  const hosting = useNewestCard(card, first ? wantsAuni(first, auni) : null);
  // Once Auni has been here the card keeps its room, so nothing moves when it leaves for a newer one.
  const [roomy, setRoomy] = useState(false);
  if (hosting && !roomy) setRoomy(true);
  return (
    <div className="my-2 min-w-0">
      {/* Auni can come after the card has drawn, once its state is in, so its room eases open. */}
      <AutoHeight>
        <div style={{ height: roomy ? headroom(EDGE_SIZE) - 8 : 0 }} />
      </AutoHeight>
      {/* Auni hangs behind the card and holds on in front of it, in a stack of their own. */}
      <div className="relative isolate">
        {/* It clips what runs past its edge, so it wraps any word too long for it (a token's
            name is its maker's, unbroken at any length): nothing a card says is cut off. */}
        <section
          ref={setCard}
          aria-label={label}
          className={cn(
            "relative z-[1] w-full min-w-0 overflow-hidden rounded-card break-words border bg-card text-ink transition-[border-color] duration-500 ease-settle",
            tone === "waiting" || tone === "warning"
              ? "border-waiting-mark/60"
              : tone === "failed"
                ? "border-destructive/40"
                : "border-border",
          )}
          data-phase={phase}
          data-tone={tone ?? undefined}
          data-testid="money-card"
        >
          {/* A change of phase, or of anything in the card, eases it to its new height, padding and all. */}
          <AutoHeight>
            <div className={settled ? "px-4 py-3.5" : "p-5 sm:p-6"}>
              <div key={phase} className={cn("relative", phase !== firstPhase && styles.enter)}>
                {children}
              </div>
            </div>
          </AutoHeight>
        </section>
        {hosting && card && auni ? <EdgeMascot card={card} scene={auni} /> : null}
      </div>
    </div>
  );
}

/**
 * The head of any card: its mark, what it is, the line under that (where it runs, or where it
 * stands now), and the one figure it is about on the right, or an action in its place (Get a
 * key). `compact` is a settled card's.
 */
export function CardHead({
  action = null,
  compact = false,
  figure = null,
  line = null,
  mark,
  title,
  under = null,
}: {
  readonly action?: ReactNode;
  readonly compact?: boolean;
  readonly figure?: { readonly value: ReactNode; readonly note?: ReactNode } | null;
  readonly line?: ReactNode;
  readonly mark: ReactNode;
  readonly title: ReactNode;
  /** What sits under the words, in their column at every width (a failed move's way on). */
  readonly under?: ReactNode;
}) {
  // The mark's column, then the words': anything under them starts where they do, whatever the
  // mark's size, and the mark is centred on the words alone.
  return (
    <div
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)] items-center",
        compact ? "gap-x-3.5" : "gap-x-3",
        action && "sm:grid-cols-[auto_minmax(0,1fr)_auto]",
      )}
    >
      {mark}
      <div className={cn("flex min-w-0 items-center", compact ? "gap-3.5" : "gap-3")}>
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              "font-semibold text-pretty text-ink",
              compact
                ? "text-body leading-5 tracking-[-0.01em]"
                : "line-clamp-2 text-reading leading-[1.3] tracking-[-0.015em]",
            )}
          >
            {title}
          </p>
          {line ? (
            <div className="mt-0.5 text-meta leading-[18px] text-pretty text-muted-foreground">
              {line}
            </div>
          ) : null}
        </div>
        {figure ? (
          <div className="flex-none self-center pl-1 text-right">
            <p
              className={cn(
                "text-ink tabular-nums",
                compact
                  ? "text-body leading-5 font-semibold tracking-[-0.01em]"
                  : "text-card-money",
              )}
            >
              {figure.value}
            </p>
            {figure.note ? (
              <p className="mt-0.5 text-meta leading-4 text-muted-foreground">{figure.note}</p>
            ) : null}
          </div>
        ) : null}
      </div>
      {/* Beside the words; on a phone under them, so they keep the card's width. */}
      {action ? (
        <div className="col-start-2 mt-3 flex sm:col-start-3 sm:row-start-1 sm:mt-0">{action}</div>
      ) : null}
      {under ? <div className="col-start-2 mt-3">{under}</div> : null}
    </div>
  );
}

/**
 * A settled card: its mark (with a tick or a cross), what happened in past tense, what it
 * means now, and its figure; what can still help sits under it.
 */
export function CardReceipt({
  action = null,
  amount = null,
  amountNote = null,
  detail,
  mark,
  title,
  trailing = null,
  whole = false,
}: {
  /** One way on, beside the words (Open Elfa, Back up). */
  readonly action?: ReactNode;
  readonly amount?: ReactNode;
  /** What the figure is, under it: "realized". */
  readonly amountNote?: ReactNode;
  readonly detail: ReactNode;
  readonly mark: ReactNode;
  readonly title: ReactNode;
  /** What can help now (Try again, Ask Auni), under the words. */
  readonly trailing?: ReactNode;
  /** Why a move failed is read to its end, where what a done one means now keeps to two lines. */
  readonly whole?: boolean;
}) {
  return (
    <CardHead
      compact
      mark={mark}
      title={title}
      line={
        detail ? (
          <span className={cn("tabular-nums", !whole && "line-clamp-2")}>{detail}</span>
        ) : null
      }
      figure={amount ? { value: amount, note: amountNote } : null}
      action={action}
      under={trailing}
    />
  );
}

/**
 * A card's two answers: Decline, quiet and short, and the move itself in ink, named by its verb
 * and amount ("Buy $250"), taking the rest of the row.
 */
export function CardActions({
  decline,
  children,
}: {
  readonly decline: {
    readonly busy?: boolean;
    readonly disabled?: boolean;
    readonly onClick: () => void;
  } | null;
  /** The main button (a CardButton), or a field's own actions. */
  readonly children: ReactNode;
}) {
  return (
    <div className="flex gap-2">
      {decline ? (
        <CardButton
          tone="quiet"
          busy={decline.busy}
          busyLabel="Declining"
          disabled={decline.disabled}
          onClick={decline.onClick}
          className="flex-none px-5"
        >
          Decline
        </CardButton>
      ) : null}
      <div className="flex min-w-0 flex-1 [&>*]:w-full">{children}</div>
    </div>
  );
}

export function CardButton({
  busy = false,
  busyLabel,
  children,
  className,
  disabled,
  onClick,
  tone,
}: {
  readonly busy?: boolean | undefined;
  /** What a screen reader hears while it's busy, since the hidden label is hidden from it too. */
  readonly busyLabel?: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly disabled?: boolean | undefined;
  readonly onClick: () => void;
  readonly tone: "primary" | "quiet" | "outline";
}) {
  return (
    <button
      type="button"
      aria-busy={busy || undefined}
      // Auni, over the card's edge, leans toward the primary as the pointer nears it.
      data-tone={tone}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        buttonVariants({
          variant: tone === "quiet" ? "secondary" : tone,
          size: "lg",
        }),
        "font-semibold",
        // A main button that can't be pressed yet waits pale, and darkens the moment it can.
        tone === "primary" &&
          !busy &&
          "disabled:bg-foreground/[0.06] disabled:text-muted-foreground disabled:opacity-100",
        busy && "disabled:opacity-100",
        className,
      )}
    >
      {/* The label keeps its room while the spinner shows, so the button never changes width. */}
      <span className={cn("flex min-w-0 items-center gap-2", busy && "invisible")}>{children}</span>
      {busy ? (
        <LoaderCircle
          aria-hidden
          className="absolute inset-0 m-auto size-4 animate-spin motion-reduce:animate-none"
        />
      ) : null}
      {busy && busyLabel ? <span className="sr-only">{busyLabel}</span> : null}
    </button>
  );
}

/** "That didn't reach Auni", said where a tap was made. */
export function CardAlert({ children }: { readonly children: ReactNode }) {
  return (
    <p role="alert" className="mt-4 text-meta leading-[18px] text-destructive">
      {children}
    </p>
  );
}

/** What a tap that never got an answer says. */
export const NOT_REACHED_TAP = "Couldn't reach Auni. Try again.";
