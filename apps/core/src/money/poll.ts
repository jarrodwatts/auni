/**
 * Asks `check` up to `tries` times, waiting `every` milliseconds after each answer that is
 * undefined, and gives its first answer that isn't, else undefined once every try has waited out.
 * A throw from `check` ends it at once.
 */
export async function poll<T>(
  check: () => Promise<T | undefined>,
  { every, tries }: { readonly every: number; readonly tries: number },
): Promise<T | undefined> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const answer = await check();
    if (answer !== undefined) return answer;
    // The global timer, so a test can run the waits on fake time.
    await new Promise((resolve) => setTimeout(resolve, every));
  }
  return undefined;
}
