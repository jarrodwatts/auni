/**
 * The pile of pages Auni reads at a chat's first answer (components/conversation/reading-auni.tsx):
 * the owner's take first, then each page the work reads (a site, a pick), landing one at a time
 * as soon as it's read, and once all have landed, round them again while the work goes on, so the
 * wait never stops on one page.
 */

/** How many pages lie on the pile, the newest on top. */
const PILE = 3;
/** How long the first page takes to land once read, one not yet on the pile, and one read again. */
const FIRST_PAGE_MS = 250;
const NEW_PAGE_MS = 1_400;
const AGAIN_MS = 2_600;

/**
 * Which of the `read` pages lands next, after `landed` (each landing's page, oldest first): the
 * first not yet on the pile, so a page just read never waits behind a round; else the one after
 * the last, round again.
 */
export function nextPage(landed: readonly number[], read: number): number {
  const fresh = landed.length === 0 ? 0 : Math.max(...landed) + 1;
  return fresh < read ? fresh : ((landed.at(-1) ?? -1) + 1) % read;
}

/** How long until the next page lands, with `read` pages read so far, or null with none yet. */
export function nextLandingIn(landed: readonly number[], read: number): number | null {
  if (read === 0) return null;
  if (landed.length === 0) return FIRST_PAGE_MS;
  return nextPage(landed, read) > Math.max(...landed) ? NEW_PAGE_MS : AGAIN_MS;
}

/**
 * The pile after `landed`, oldest first: the take (null) under the newest landings, each keyed by
 * the landing that put it there, so a page read again lands anew.
 */
export function pileOf<Page>(
  landed: readonly number[],
  pages: readonly Page[],
): readonly { readonly landing: number; readonly page: Page | null }[] {
  return [
    { landing: 0, page: null },
    ...landed.map((index, at) => ({ landing: at + 1, page: pages[index] ?? null })),
  ].slice(-PILE);
}
