"use client";

import "./rolling-number.css";

import { useState } from "react";

import { reducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface RollingSlot {
  readonly key: string;
  readonly char: string;
  readonly isDigit: boolean;
}

/**
 * Splits formatted numbers/durations ("12s", "1m 5s", "6") into stable slots
 * where numeric digits are keyed by place value from the right of each numeric
 * run so 9 -> 10 rolls the ones place (9 -> 0) while 1 enters cleanly on the left.
 */
export function rollingSlots(value: string): readonly RollingSlot[] {
  const slots: RollingSlot[] = [];
  const tokens = value.match(/\d+|\D+/gu) ?? [];
  let runIndex = 0;
  for (const token of tokens) {
    if (/^\d+$/u.test(token)) {
      const length = token.length;
      for (let index = 0; index < length; index += 1) {
        const place = length - 1 - index;
        slots.push({
          key: `d-${runIndex}-${place}`,
          char: token[index]!,
          isDigit: true,
        });
      }
      runIndex += 1;
    } else {
      slots.push({ key: `t-${slots.length}-${token}`, char: token, isDigit: false });
    }
  }
  return slots;
}

/**
 * Odometer-style rolling numeric display: only the changing digit rolls
 * vertically through a soft-masked window while surrounding letters stay still.
 */
export function RollingNumber({
  className,
  value,
}: {
  readonly className?: string;
  readonly value: number | string;
}) {
  const text = String(value);
  const slots = rollingSlots(text);
  return (
    <span aria-label={text} className={cn("inline-flex items-center tabular-nums", className)}>
      {slots.map((slot) =>
        slot.isDigit ? (
          <RollingDigit char={slot.char} key={slot.key} />
        ) : (
          <span aria-hidden className="whitespace-pre" key={slot.key}>
            {slot.char}
          </span>
        ),
      )}
    </span>
  );
}

function RollingDigit({ char }: { readonly char: string }) {
  const [state, setState] = useState<{
    readonly current: string;
    readonly prev: string | null;
    readonly tick: number;
  }>({ current: char, prev: null, tick: 0 });

  if (state.current !== char) {
    setState({
      current: char,
      prev: reducedMotion() ? null : state.current,
      tick: state.tick + 1,
    });
  }

  return (
    <span aria-hidden className="auni-digit-window">
      {state.prev !== null ? (
        <span className="auni-digit-out" key={`out-${state.tick}`}>
          {state.prev}
        </span>
      ) : null}
      <span className={state.prev !== null ? "auni-digit-in" : undefined} key={`in-${state.tick}`}>
        {state.current}
      </span>
    </span>
  );
}
