// Turns run in this process (jobs/turn.ts), so stopping one is aborting it here.
const running = new Map<
  string,
  { readonly turnId: string; readonly controller: AbortController }
>();

/**
 * Registers the running turn for a thread; the signal fires when someone stops it, or when
 * `ended` does (the job runner ending turns as the machine sleeps or Auni stops).
 */
export function trackTurn(
  threadId: string,
  turnId: string,
  ended?: AbortSignal,
): { readonly signal: AbortSignal; release(): void } {
  const turn = { turnId, controller: new AbortController() };
  running.set(threadId, turn);
  const { signal } = turn.controller;
  return {
    signal: ended ? AbortSignal.any([signal, ended]) : signal,
    release: () => {
      if (running.get(threadId) === turn) running.delete(threadId);
    },
  };
}

/** Stops the thread's running turn, if one is; given `turnId`, only when it is that turn. */
export function stopTurn(threadId: string, turnId?: string): void {
  const turn = running.get(threadId);
  if (turn && (turnId === undefined || turn.turnId === turnId)) turn.controller.abort();
}
