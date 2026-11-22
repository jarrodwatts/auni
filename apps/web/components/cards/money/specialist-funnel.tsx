"use client";

import { CircleAlert, Plus } from "lucide-react";
import type { ReactNode } from "react";

import { AutoHeight } from "@/components/motion/auto-height";

import { MoneyButton, MoneyButtons } from "./money-card-parts";
import styles from "./money-card.module.css";
import funnel from "./specialist-funnel.module.css";

/**
 * The steps at the foot of a money card, from a first look to the
 * tap and, once it's all in, the finish. Each step replaces the last inside
 * a box that eases to its height, so the card above it never moves.
 */
export function FooterMorph({
  children,
  stepKey,
}: {
  readonly children: ReactNode;
  readonly stepKey: string;
}) {
  return (
    <AutoHeight className="mt-5">
      <div key={stepKey} className={styles.step}>
        {children}
      </div>
    </AutoHeight>
  );
}

export function StepError({ children }: { readonly children: string | null }) {
  if (!children) return null;
  return (
    <p className="mb-3 flex items-start gap-2 text-[13px] leading-5 text-destructive" role="alert">
      <CircleAlert aria-hidden className="mt-0.5 size-3.5 flex-none" />
      {children}
    </p>
  );
}

/** Signed in and short: the move opens Add money, to send in what's short. */
export function FundStep({
  error,
  needUsd,
  onAdd,
  onDecline,
  pending,
  watching,
}: {
  readonly error: string | null;
  readonly needUsd: string;
  readonly onAdd: () => void;
  readonly onDecline: () => void;
  readonly pending: "allow" | "decline" | null;
  /** Add money was opened for this shortfall: what was sent, if anything, may still land. */
  readonly watching: boolean;
}) {
  return (
    <>
      <StepError>{error}</StepError>
      {watching && !error ? (
        <p className="mb-3 text-[13px] leading-5 text-muted-foreground">
          Sent it already? It can take a few minutes to show up here.
        </p>
      ) : null}
      <MoneyButtons>
        <MoneyButton
          busy={pending === "decline"}
          disabled={pending !== null}
          tone="quiet"
          onClick={onDecline}
        >
          Not now
        </MoneyButton>
        <MoneyButton disabled={pending !== null} tone="primary" onClick={onAdd}>
          <Plus aria-hidden className="size-4" />
          Add ${wholeDollars(needUsd).toLocaleString("en-US")} to start
        </MoneyButton>
      </MoneyButtons>
    </>
  );
}

/** "23.5" needs $24: whole dollars that cover the gap. */
export function wholeDollars(needUsd: string): number {
  const value = Math.ceil(Number(needUsd));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export function ReadyStep({
  error,
  landed,
  move,
  onAllow,
  onDecline,
  pending,
}: {
  readonly error: string | null;
  readonly landed: boolean;
  /** The primary names what it does: "Start with $100". */
  readonly move: string;
  readonly onAllow: () => void;
  readonly onDecline: () => void;
  readonly pending: "allow" | "decline" | null;
}) {
  return (
    <>
      <StepError>{error}</StepError>
      <MoneyButtons>
        <MoneyButton
          busy={pending === "decline"}
          disabled={pending !== null}
          tone="quiet"
          onClick={onDecline}
        >
          Not now
        </MoneyButton>
        <MoneyButton
          busy={pending === "allow"}
          className={landed ? funnel.glow : undefined}
          disabled={pending !== null}
          tone="primary"
          onClick={onAllow}
        >
          {move}
        </MoneyButton>
      </MoneyButtons>
    </>
  );
}

/**
 * What of the person's holdings a card converts to pay for itself, said
 * before the tap, since nothing converts until then.
 */
export function PaysWith({ lines }: { readonly lines: readonly string[] }) {
  if (lines.length === 0) return null;
  return (
    <ul className="mt-3 flex flex-col gap-1 text-[13px] leading-[1.4] text-muted-foreground">
      {lines.map((line) => (
        <li key={line}>
          <span className="font-medium text-ink">Pays with</span> {line}
        </li>
      ))}
    </ul>
  );
}

/** What a card's moves cost in all, in core's words, said before the tap, as how it pays is. */
export function Costs({ costs }: { readonly costs: string | undefined }) {
  if (!costs) return null;
  return (
    <p className="mt-3 text-[13px] leading-[1.4] text-muted-foreground">
      <span className="font-medium text-ink">Costs</span> {costs}
    </p>
  );
}

/**
 * A sentence core wrote that a card of several moves says before the tap: what it sends first to
 * buy the coin its network fees are paid in, since Allow signs that too, or that a trade waiting
 * for its money moves is priced again when its turn comes.
 */
export function CardNote({ says }: { readonly says: string | undefined }) {
  if (!says) return null;
  return <p className="mt-3 text-[13px] leading-[1.4] text-muted-foreground">{says}</p>;
}

/** Money counting up as it goes in, each digit rolling to its new value. */
export function RollingNumber({ value }: { readonly value: string }) {
  const chars = [...value];
  return (
    <span className="inline-flex">
      <span className="sr-only">{value}</span>
      {chars.map((char, index) =>
        // Keyed from the right, so "$9" becoming "$15" rolls the units rather than shifting them.
        /\d/u.test(char) ? (
          <span key={chars.length - index} aria-hidden className="h-lh overflow-hidden">
            <span className={funnel.roll} style={{ transform: `translateY(-${char}lh)` }}>
              {DIGITS.map((digit) => (
                <span key={digit}>{digit}</span>
              ))}
            </span>
          </span>
        ) : (
          <span key={chars.length - index} aria-hidden>
            {char}
          </span>
        ),
      )}
    </span>
  );
}

const DIGITS = [..."0123456789"];

/** One line where a proposal used to be: declined, or updated by a newer one. */
export function ProposalReceipt({
  mark,
  name,
  status,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  readonly status: string;
}) {
  return (
    <div className="flex items-center gap-3.5">
      <span className="flex flex-none opacity-55 grayscale">{mark}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">{name}</p>
        <p className="truncate text-[13px] text-muted-foreground">{status}</p>
      </div>
    </div>
  );
}
