import { setting } from "../../settings.ts";
import { OutOfCredits } from "../contract.ts";
import about from "./about.ts";

export const BASE_URL = "https://api.elfa.ai";
const TIMEOUT_MS = 20_000;

export class ElfaError extends Error {}

export const ELFA_BUSY = "Elfa is busy right now; try again in a minute.";

/** The owner's Elfa key as it is now, so one saved from the app works on the next call. */
export const elfaKey = () => setting(about, "apiKey");

/**
 * One call to Elfa with Auni's key: Auto (/v2/auto) and the data API (/v3)
 * share it, and its 60 requests a minute. A status outside `accept` throws.
 */
export async function elfaRequest(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    accept?: readonly number[];
    timeoutMs?: number;
  } = {},
): Promise<Record<string, unknown>> {
  const key = elfaKey();
  if (!key) throw new ElfaError("Elfa is not configured.");
  const response = await fetch(`${BASE_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      accept: "application/json",
      "x-elfa-api-key": key,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      body = parsed as Record<string, unknown>;
  } catch {
    // A non-JSON body only matters when the status is also wrong.
  }
  if (!(init.accept ?? [200, 201]).includes(response.status)) {
    // Core keeps a key out of credits on Elfa's sheet and in doctor (app-troubles.ts).
    if (response.status === 429) throw new ElfaError(ELFA_BUSY);
    if (response.status === 402) throw new OutOfCredits(`Elfa is out of credits: ${text}`);
    throw new ElfaError(`Elfa ${response.status}: ${text.slice(0, 1_000) || response.statusText}`);
  }
  return body;
}
