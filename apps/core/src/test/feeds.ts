import type { App, Tokens } from "../apps/contract.ts";
import type * as Generated from "../apps/index.generated.ts";

/**
 * Stand-in price feeds, in place of the apps that fill the tokens role. A test of how core reads
 * prices (money/history.ts, money/portfolio.ts) holds core's own rules only when it doesn't
 * depend on which feeds are installed: with the real ones, a feed someone adds later answers in
 * its own way and changes what the test sees. So such a test stands in for the role:
 *
 *   vi.mock(import("../apps/index.generated.ts"), async (original) =>
 *     (await import("../test/feeds.ts")).withFeeds(await original()));
 *
 * and says in each case which feeds there are, first asked first, with `useFeeds`. The app list
 * is stood in for, not the registry: a module loaded while a stood-in registry loads would be
 * handed the real one, and money/token-feeds.ts is such a module.
 */
let feeds: readonly Tokens[] = [];

export function useFeeds(...these: readonly Tokens[]): void {
  feeds = these;
}

/** As many feeds as a test may use at once. */
const SLOTS = 3;

/** A feed app whose parts are the `slot`th feed's, or none while a test uses fewer. */
function slotApp(slot: number): App {
  const part = (name: keyof Tokens) => () => feeds[slot]?.[name];
  const tokens = Object.defineProperties({} as Tokens, {
    prices: { get: part("prices"), enumerable: true },
    history: { get: part("history"), enumerable: true },
  });
  return { about: { id: `stand-in-feed-${slot}`, name: `Stand-in feed ${slot}` }, tokens } as App;
}

/** The app list with no feed of its own, and the stand-in feeds in their place, in order. */
export function withFeeds(generated: typeof Generated): typeof Generated {
  const apps = generated.APPS.map(({ tokens: _feed, ...app }) => app as App);
  return {
    ...generated,
    APPS: [...apps, ...Array.from({ length: SLOTS }, (_, slot) => slotApp(slot))] as never,
  };
}

/** A feed that prices from a fixed table, now and at any moment, and keeps what it is asked. */
export function tableFeed(table: Readonly<Record<string, number>>, asked: string[] = []): Tokens {
  return {
    async prices(ids) {
      asked.push(...ids);
      return new Map(
        ids.flatMap((id) => (table[id] === undefined ? [] : [[id, { price: table[id] }] as const])),
      );
    },
  };
}

/** A feed that can't be read just now. */
export const downFeed: Tokens = {
  async prices() {
    throw new Error("The stand-in feed is down.");
  },
};
