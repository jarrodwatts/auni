/**
 * How well a name answers what was typed: whole name, then its start, then
 * the start of any word in it, then anywhere. Each typed word has to be
 * found, so "ai ch" finds "AI chips" and "nvid" finds "Nvidia".
 */

/** Lowercased, accents off, so "Pokémon" answers "pokemon". */
function foldName(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

function wordStarts(name: string, word: string): boolean {
  let from = name.indexOf(word);
  while (from !== -1) {
    if (from === 0 || !/[\p{L}\p{N}]/u.test(name[from - 1] ?? "")) return true;
    from = name.indexOf(word, from + 1);
  }
  return false;
}

/** 0 when nothing matches; the higher, the better the match. */
export function matchScore(needle: string, names: readonly (string | null | undefined)[]): number {
  const folded = foldName(needle.trim());
  if (!folded) return 0;
  const words = folded.split(/\s+/u);
  let best = 0;
  for (const raw of names) {
    if (!raw) continue;
    const name = foldName(raw);
    if (name === folded) return 5;
    if (name.startsWith(folded)) best = Math.max(best, 4);
    else if (wordStarts(name, folded)) best = Math.max(best, 3);
    else if (words.every((word) => wordStarts(name, word))) best = Math.max(best, 2);
    else if (name.includes(folded)) best = Math.max(best, 1);
  }
  return best;
}
