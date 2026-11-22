import type { ReactNode } from "react";

import { Mascot, type MascotState } from "@/components/brand/mascot";
import { MoneyButton } from "@/components/cards/money/money-card-parts";
import { CopyLine } from "@/components/ui/copy-line";
import { cn } from "@/lib/utils";

/** One step's card, and every notice's: what it is, why, and what to do. */
export function Card({
  pose,
  waiting = false,
  title,
  body,
  children,
}: {
  /** A mascot over the card, for a card the frame gives none (a notice). */
  readonly pose?: MascotState;
  /** The mascot floats while Auni waits on something that carries on by itself. */
  readonly waiting?: boolean;
  readonly title: string;
  readonly body?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <section className="rounded-[24px] bg-card px-5 pt-6 pb-5 shadow-[0_24px_70px_--alpha(var(--color-shade)/8%)] sm:px-7 sm:pt-7 sm:pb-6">
      {pose ? (
        <Mascot
          alt=""
          className={cn("mx-auto mb-4", waiting ? "auni-float" : "auni-onb-mascot")}
          priority
          size={64}
          state={pose}
        />
      ) : null}
      <h1 className="text-center text-[24px] leading-[30px] font-semibold tracking-[-0.03em] text-ink">
        {title}
      </h1>
      {body ? (
        <p
          role={pose ? "status" : undefined}
          className="mx-auto mt-2 max-w-[380px] text-center text-[15px] leading-[1.5] text-muted-foreground"
        >
          {body}
        </p>
      ) : null}
      {children ? <div className="mt-6">{children}</div> : null}
    </section>
  );
}

/**
 * Something in the way, in first run or before it: what happened, the command that shows why or
 * fixes it, and Try again when trying again could help.
 */
export function NoticeCard({
  pose,
  waiting,
  title,
  body,
  command,
  onRetry,
  retrying = false,
}: {
  readonly pose: MascotState;
  readonly waiting?: boolean;
  readonly title: string;
  readonly body: string;
  readonly command?: string;
  readonly onRetry?: () => void;
  readonly retrying?: boolean;
}) {
  const acts = command || onRetry;
  return (
    <Card pose={pose} waiting={waiting} title={title} body={body}>
      {acts ? (
        <div className="flex flex-col gap-3">
          {command ? <CopyLine value={command} command /> : null}
          {onRetry ? (
            <MoneyButton tone="primary" className="w-full" busy={retrying} onClick={onRetry}>
              Try again
            </MoneyButton>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
