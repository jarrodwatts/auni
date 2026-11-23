export function formatWorkDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  if (totalSeconds < 1) return "<1s";
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours > 0 && `${hours}h`, minutes > 0 && `${minutes}m`, seconds > 0 && `${seconds}s`]
    .filter(Boolean)
    .join(" ");
}

/** Crisp per-step duration beside a finished step: "420ms", "1.2s", "14s". */
export function formatStepDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    const rounded = Math.max(10, Math.round(durationMs / 10) * 10);
    return `${rounded}ms`;
  }
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  return formatWorkDuration(durationMs);
}

/**
 * Live ticking elapsed time shown while a turn is running: stays silent under
 * one second so quick responses never flash "0s", then counts whole seconds.
 */
export function formatLiveElapsed(startedAtMs: number | null, nowMs: number): string {
  if (startedAtMs === null) return "";
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  if (elapsedMs < 1_000) return "";
  return formatWorkDuration(elapsedMs);
}

/**
 * Final duration shown once work settles: crisp tenths under 10s ("3.0s"),
 * whole seconds and minutes beyond ("12s", "1m 5s"), or null when unknown.
 */
export function formatSettledDuration(durationMs: number | null | undefined): string | null {
  if (durationMs === null || durationMs === undefined || durationMs <= 0) return null;
  if (durationMs < 10_000) return `${Math.max(0.1, durationMs / 1_000).toFixed(1)}s`;
  return formatWorkDuration(durationMs);
}

/** Parses an ISO timestamp into epoch ms, falling back when absent or invalid. */
export function parseStartMs(startedAt: string | undefined, fallbackMs: number): number {
  if (startedAt === undefined) return fallbackMs;
  const parsed = Date.parse(startedAt);
  return Number.isFinite(parsed) ? parsed : fallbackMs;
}
