"use client";

import {
  useLayoutEffect,
  useRef,
  type Dispatch,
  type RefCallback,
  type SetStateAction,
} from "react";

import { hold } from "@/lib/motion";

import { swapGone, type Swap } from "./swap";

/** One way in or out: the keyframes and their timing. */
export interface Motion {
  readonly keyframes: Keyframe[];
  readonly options: KeyframeAnimationOptions;
}

/**
 * Runs a swap's motion. At each handover the copy that was current leaves
 * from wherever it had got to, and is forgotten once gone, while the new one
 * arrives. Returns the ref to draw each copy with, by its id.
 */
export function useHandover<T>(
  swap: Swap<T>,
  setSwap: Dispatch<SetStateAction<Swap<T>>>,
  leave: Motion,
  arrive: Motion,
): (id: number) => RefCallback<HTMLElement> {
  const copies = useRef(new Map<number, HTMLElement>());
  const arrival = useRef<Animation | null>(null);
  const handled = useRef(swap.id);

  useLayoutEffect(() => {
    if (swap.id === handled.current) return;
    const since = handled.current;
    handled.current = swap.id;
    // Cut short, an arrival leaves from where it got to rather than from its end.
    hold(arrival.current);
    // Usually one copy leaves; two changes in one render send both.
    for (const { id } of swap.leaving) {
      if (id < since) continue;
      copies.current
        .get(id)
        ?.animate(leave.keyframes, { ...leave.options, fill: "forwards" })
        .finished.then(
          () => setSwap((now) => swapGone(now, id)),
          () => undefined,
        );
    }
    arrival.current =
      copies.current.get(swap.id)?.animate(arrive.keyframes, arrive.options) ?? null;
  }, [arrive, leave, setSwap, swap]);

  return (id) => (node) => {
    if (!node) return undefined;
    copies.current.set(id, node);
    return () => {
      copies.current.delete(id);
    };
  };
}
