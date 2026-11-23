const listeners = new Set<() => void>();
let intervalId: number | null = null;

/**
 * Subscribes to one shared 1-second clock across the tab. Starts the interval on
 * the first live subscriber and clears it as soon as the last one unsubscribes.
 */
export function subscribeSecondTick(listener: () => void): () => void {
  listeners.add(listener);
  if (intervalId === null && typeof window !== "undefined") {
    intervalId = window.setInterval(() => {
      for (const callback of listeners) callback();
    }, 1_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null && typeof window !== "undefined") {
      window.clearInterval(intervalId);
      intervalId = null;
    }
  };
}
