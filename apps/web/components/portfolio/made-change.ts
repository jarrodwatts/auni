/** A reading as a move is measured: when, its value, and what it had made by then. */
export interface MadeReading {
  readonly at: number;
  readonly value: bigint;
  readonly made: bigint;
}

/**
 * What money made from the first reading to the last, and that as a percent
 * of the money at work: the first's value plus each later amount put in or
 * taken out, weighted by the share of the period left after it (Modified
 * Dietz, as specialist returns are). Money added just before the end barely
 * counts, and money taken out was at work until it left. What a reading had
 * put in all told is its value less what it had made.
 */
export function madeChange(
  readings: readonly MadeReading[],
): { readonly change: bigint; readonly percent: number } | null {
  const first = readings[0];
  const last = readings.at(-1);
  if (!first || !last) return null;
  const span = last.at - first.at;
  let base = Number(first.value);
  for (let index = 1; index < readings.length; index += 1) {
    const now = readings[index]!;
    const before = readings[index - 1]!;
    const putIn = now.value - now.made - (before.value - before.made);
    base += Number(putIn) * (span > 0 ? (last.at - now.at) / span : 0);
  }
  const change = last.made - first.made;
  return { change, percent: base > 0 ? (Number(change) / base) * 100 : 0 };
}
