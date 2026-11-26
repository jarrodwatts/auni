import { Check, X } from "lucide-react";

import { LogoImage, NoMark } from "@/components/brand/marks";
import { IntegrationMark } from "@/components/integrations/integration-mark";
import { TextSwap } from "@/components/motion/text-swap";
import { TurnTag } from "@/components/places/place-marks";
import { cn } from "@/lib/utils";

import { CardButton } from "../card-parts";
import type { MoneyCardMark } from "./action-card-content";
import { needsYouLabel } from "./failed-step";
import styles from "./money-card.module.css";

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
            // A logo is a circle and a venue's mark a rounded square; the ring keeps 5px off either.
            mark.kind === "integration" ? "rounded-card" : "rounded-full",
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

/**
 * What a card of several picks is about: the first two picks' own logos, the second tucked
 * under the first's corner, so a basket reads as what is in it. Muted once it ended untapped.
 */
export function PairMark({
  marks,
  muted = false,
  size = 44,
}: {
  readonly marks: readonly [MoneyCardMark, MoneyCardMark];
  readonly muted?: boolean;
  readonly size?: number;
}) {
  const each = Math.round(size * 0.72);
  return (
    <span
      aria-hidden
      className={cn("relative flex-none", muted && "opacity-55 grayscale")}
      style={{ width: size, height: size }}
    >
      <span className="absolute top-0 left-0 flex">
        <MarkFace mark={marks[0]} size={each} />
      </span>
      <span className="absolute right-0 bottom-0 flex rounded-full shadow-[0_0_0_2px_var(--card)]">
        <MarkFace mark={marks[1]} size={each} />
      </span>
    </span>
  );
}

/** A mark itself: its picture, else what stands in for it. */
export function MarkFace({ mark, size }: { readonly mark: MoneyCardMark; readonly size: number }) {
  switch (mark.kind) {
    case "integration":
      return <IntegrationMark integration={mark.integration} size={size} />;
    case "initials":
      return <NoMark size={size} />;
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
    <span aria-hidden className={cn("flex-none text-meta text-muted-foreground", styles.late)}>
      Can take a minute
    </span>
  );
}

/**
 * A card's button, as screens outside the conversation (an app's sheet, first run, Settings)
 * borrow it; a card itself uses CardButton and CardActions.
 */
export const MoneyButton = CardButton;
