import { Check, LoaderCircle, X } from "lucide-react";
import { useState, type ReactNode } from "react";

import { EDGE_SIZE, EdgeMascot } from "@/components/brand/edge-mascot";
import { headroom, wantsAuni, type EdgeScene } from "@/components/brand/edge-pose";
import { LogoImage, Monogram } from "@/components/brand/marks";
import { IntegrationMark } from "@/components/integrations/integration-mark";
import { AutoHeight } from "@/components/motion/auto-height";
import { TextSwap } from "@/components/motion/text-swap";
import { TurnTag } from "@/components/places/place-marks";
import { cn } from "@/lib/utils";

import type { MoneyCardMark } from "./action-card-content";
import { needsYouLabel } from "./failed-step";
import styles from "./money-card.module.css";
import { useNewestCard } from "./use-newest-card";

/**
 * A money card is an object: a white card with a crisp hairline, barely
 * lifted, its color left to the mark it is about. Once settled it eases
 * down to a one-line receipt tile.
 */
export function MoneyCardFrame({
  auni = null,
  children,
  flat = false,
  label,
  phase,
}: {
  /**
   * What Auni, peeking over the card's top edge, makes of it; null where it
   * has nothing to watch. It comes only to the newest card that wants it,
   * never to one already settled when it first showed, and once a card has
   * settled and Auni has left it for a newer one, never back.
   */
  readonly auni?: EdgeScene | null;
  readonly children: ReactNode;
  /** A receipt of something finished: it rests on the page instead of lifting off it. */
  readonly flat?: boolean;
  readonly label: string;
  readonly phase: "open" | "confirmed" | "expired";
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
        <section
          ref={setCard}
          aria-label={label}
          className={cn(
            "relative z-[1] w-full min-w-0 overflow-hidden border border-foreground/[0.08] bg-card text-ink transition-shadow duration-500",
            settled ? "rounded-[18px]" : cn("rounded-[22px]", !flat && "shadow-card"),
          )}
          data-phase={phase}
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

/** Two equal-height buttons on one row: the quiet way out, and the move itself in black. */
export function MoneyButtons({ children }: { readonly children: ReactNode }) {
  return <div className="grid grid-cols-[1fr_1.6fr] gap-2">{children}</div>;
}

/**
 * What a money card is about. While its money moves a ring turns around it,
 * the shape of the mark; when it lands the ring closes and gives way to the
 * tick.
 */
export function MoneyMark({
  mark,
  done = false,
  failed = false,
  muted = false,
  ring = null,
  size = 44,
}: {
  readonly mark: MoneyCardMark;
  readonly done?: boolean;
  readonly failed?: boolean;
  readonly muted?: boolean;
  readonly ring?: "working" | "landed" | null;
  readonly size?: number;
}) {
  return (
    <span className={cn("relative flex-none", muted && "opacity-55 grayscale")}>
      {ring ? (
        <span
          aria-hidden
          className={cn(
            styles.ring,
            // A logo or initials is a circle and a venue's mark a rounded square; the ring keeps 5px off either.
            mark.kind === "integration" ? "rounded-[18px]" : "rounded-full",
          )}
          data-landed={ring === "landed" || undefined}
        />
      ) : null}
      <MarkFace mark={mark} size={size} />
      {done || failed ? (
        <span
          className={cn(
            "absolute -right-1 -bottom-1 flex size-[18px] items-center justify-center rounded-full border-[2.5px] border-card text-background",
            failed ? "bg-destructive" : "bg-foreground",
            ring === "landed" && styles.badge,
          )}
        >
          {failed ? (
            <X aria-hidden className="size-2.5" strokeWidth={3.4} />
          ) : (
            <Check aria-hidden className="size-2.5" strokeWidth={3.4} />
          )}
        </span>
      ) : null}
    </span>
  );
}

/** A mark itself: its picture, else what stands in for it. */
export function MarkFace({ mark, size }: { readonly mark: MoneyCardMark; readonly size: number }) {
  switch (mark.kind) {
    case "integration":
      return <IntegrationMark integration={mark.integration} size={size} />;
    case "initials":
      return <Monogram name={mark.name} size={size} />;
    case "image":
      return (
        <LogoImage
          // A mark drawn on transparency sits on the white circle, clear of its edge.
          className={mark.inset ? "p-[18%]" : undefined}
          fallback={<MarkFace mark={mark.fallback} size={size} />}
          size={size}
          src={mark.src}
        />
      );
  }
}

export function MoneyButton({
  busy = false,
  busyLabel,
  children,
  className,
  disabled,
  onClick,
  tone,
}: {
  readonly busy?: boolean;
  /** What a screen reader hears while it's busy, since the hidden label is hidden from it too. */
  readonly busyLabel?: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly disabled?: boolean;
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
        "relative flex h-12 items-center justify-center rounded-full px-5 text-[15px] font-semibold transition-[background-color,transform,opacity] duration-200 ease-settle active:scale-[0.985] disabled:pointer-events-none disabled:opacity-60",
        tone === "primary" && "bg-foreground text-background hover:bg-foreground/85",
        // A main button that can't be pressed yet waits pale, and darkens the moment it can.
        tone === "primary" &&
          !busy &&
          "disabled:bg-foreground/[0.05] disabled:text-muted-foreground disabled:opacity-100",
        tone === "quiet" && "bg-foreground/[0.05] text-ink hover:bg-foreground/[0.08]",
        tone === "outline" && "border border-foreground/[0.12] text-ink hover:bg-foreground/[0.03]",
        busy && "disabled:opacity-100",
        className,
      )}
    >
      {/* The label keeps its room while the spinner shows, so the button never changes width. */}
      <span className={cn("flex items-center gap-2", busy && "invisible")}>{children}</span>
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

/** Beside a card's line while some of its steps wait on the person: "1 needs your OK". */
export function NeedsYou({ count }: { readonly count: number }) {
  if (count === 0) return null;
  return (
    <span className={styles.whileNewest}>
      <TurnTag>
        <TextSwap text={needsYouLabel(count)} />
      </TurnTag>
    </span>
  );
}

/** Said beside what's happening only once the wait is long enough to wonder about. */
export function Late() {
  return (
    <span aria-hidden className={cn("flex-none text-[13px] text-muted-foreground", styles.late)}>
      Can take a minute
    </span>
  );
}
