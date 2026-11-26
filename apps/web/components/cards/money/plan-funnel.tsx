"use client";

import type { ActionPlanCardWire } from "@auni/shared";
import { CircleAlert, Plus } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { CardActions, CardButton } from "@/components/cards/card-parts";
import { AutoHeight } from "@/components/motion/auto-height";

import styles from "./money-card.module.css";
import funnel from "./plan-funnel.module.css";

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
    <p className="mb-3 flex items-start gap-2 text-meta leading-5 text-destructive" role="alert">
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
        <p className="mb-3 text-meta leading-5 text-muted-foreground">
          Sent it already? It can take a few minutes to show up here.
        </p>
      ) : null}
      <CardActions
        decline={{ busy: pending === "decline", disabled: pending !== null, onClick: onDecline }}
      >
        <CardButton disabled={pending !== null} tone="primary" onClick={onAdd}>
          <Plus aria-hidden className="size-4" />
          Add ${wholeDollars(needUsd).toLocaleString("en-US")} to start
        </CardButton>
      </CardActions>
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
      <CardActions
        decline={{ busy: pending === "decline", disabled: pending !== null, onClick: onDecline }}
      >
        <CardButton
          busy={pending === "allow"}
          className={landed ? funnel.glow : undefined}
          disabled={pending !== null}
          tone="primary"
          onClick={onAllow}
        >
          <span className="truncate">{move}</span>
        </CardButton>
      </CardActions>
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
    <ul className="mt-3 flex flex-col gap-1 text-meta leading-[1.4] text-muted-foreground">
      {lines.map((line) => (
        <li key={line}>
          <span className="font-medium text-ink">Pays with</span> {line}
        </li>
      ))}
    </ul>
  );
}

/**
 * What a card's moves cost in all, each by its own name as a lone card says it ("Price impact
 * $2.70"), said before the tap, as how it pays is.
 */
export function Costs({ costs }: { readonly costs: ActionPlanCardWire["costFigures"] }) {
  if (!costs?.length) return null;
  return (
    <ul className="mt-3 space-y-1 text-meta leading-[1.4] text-muted-foreground">
      {costs.map(({ label, value }) => (
        <li key={label}>
          <span className="font-medium text-ink">{label}</span>{" "}
          <span className="tabular-nums">{value}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A sentence core wrote that a card of several moves says before the tap: what it sends first to
 * buy the coin its network fees are paid in, since Allow signs that too, or that a trade waiting
 * for its money moves is priced again when its turn comes.
 */
export function CardNote({ says }: { readonly says: string | undefined }) {
  if (!says) return null;
  return <p className="mt-3 text-meta leading-[1.4] text-muted-foreground">{says}</p>;
}

/** As long as a digit takes to roll (plan-funnel.module.css). */
const ROLL_MS = 760;

/**
 * Money counting up as it goes in, each digit rolling from its old value to its new one. At rest
 * it is plain text; the columns of digits are drawn only while a change rolls.
 */
export function RollingNumber({ value }: { readonly value: string }) {
  const [last, setLast] = useState(value);
  // A change rolling: drawn first at the old digits, then moved to the new ones.
  const [roll, setRoll] = useState<{ readonly from: string; readonly moved: boolean } | null>(null);
  if (value !== last) {
    setLast(value);
    setRoll({ from: last, moved: false });
  }
  useEffect(() => {
    if (!roll) return undefined;
    if (!roll.moved) {
      const frame = requestAnimationFrame(() => setRoll({ ...roll, moved: true }));
      return () => cancelAnimationFrame(frame);
    }
    const done = window.setTimeout(() => setRoll(null), ROLL_MS);
    return () => window.clearTimeout(done);
  }, [roll]);
  if (!roll) return <span>{value}</span>;
  const chars = [...value];
  const before = [...roll.from];
  return (
    <span className="inline-flex">
      <span className="sr-only">{value}</span>
      {chars.map((char, index) => {
        // Keyed from the right, so "$9" becoming "$15" rolls the units rather than shifting them.
        const place = chars.length - index;
        const was = before[before.length - place] ?? "0";
        const at = roll.moved ? char : /\d/u.test(was) ? was : "0";
        return /\d/u.test(char) ? (
          <span key={place} aria-hidden className="h-lh overflow-hidden">
            <span className={funnel.roll} style={{ transform: `translateY(-${at}lh)` }}>
              {DIGITS.map((digit) => (
                <span key={digit}>{digit}</span>
              ))}
            </span>
          </span>
        ) : (
          <span key={place} aria-hidden>
            {char}
          </span>
        );
      })}
    </span>
  );
}

const DIGITS = [..."0123456789"];
