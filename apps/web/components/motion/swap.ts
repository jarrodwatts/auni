/**
 * What something that hands over from one value to the next shows: the value
 * it is on, and the earlier ones still on their way out. A leaving value keeps
 * the id the value had while current, so React keeps its element, mid-motion
 * and all, as it turns from arriving to leaving.
 */
export interface Swap<T> {
  readonly current: T;
  /** The current value's id; it moves on at every handover that animates. */
  readonly id: number;
  readonly leaving: readonly { readonly id: number; readonly value: T }[];
}

export function swapOf<T>(value: T): Swap<T> {
  return { current: value, id: 0, leaving: [] };
}

/**
 * Hands over to a new value. With motion, the old one starts leaving; without,
 * or when nothing the eye would follow changed, the new one simply takes its place.
 */
export function swapTo<T>(swap: Swap<T>, next: T, animate: boolean): Swap<T> {
  if (!animate) return { ...swap, current: next };
  return {
    current: next,
    id: swap.id + 1,
    leaving: [...swap.leaving, { id: swap.id, value: swap.current }],
  };
}

/** A leaving value has finished going. */
export function swapGone<T>(swap: Swap<T>, id: number): Swap<T> {
  return { ...swap, leaving: swap.leaving.filter((each) => each.id !== id) };
}
