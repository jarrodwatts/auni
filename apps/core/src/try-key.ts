/**
 * What a service said of a key the owner typed, asked before Auni saves it (see App.tryKey and
 * settings.ts): it took it, it refused it, or it couldn't be asked. A key it refused isn't
 * saved; one it couldn't be asked about is saved all the same, and the owner is told so.
 */
export type KeyTried = "works" | "refused" | "unreachable";

/** How long a service has to answer, so a key typed while it is down is saved untried soon. */
const ANSWER_WITHIN_MS = 8_000;

/**
 * Asks a service the one call `url` names, with the typed key in `init`, and reads its answer:
 * a 2xx took the key, a status in `refusedOn` (401 and 403 unless an app says otherwise)
 * refused it, and anything else, or no answer, couldn't say. Nothing of the answer is kept,
 * and nothing that could quote the key is logged.
 */
export async function tryKeyAt(
  url: string,
  init: RequestInit,
  refusedOn: readonly number[] = [401, 403],
): Promise<KeyTried> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(ANSWER_WITHIN_MS) });
    await response.body?.cancel();
    if (response.ok) return "works";
    return refusedOn.includes(response.status) ? "refused" : "unreachable";
  } catch {
    return "unreachable";
  }
}
