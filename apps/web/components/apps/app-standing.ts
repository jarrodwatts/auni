import type { AppSettingWire, AppWire } from "@auni/shared";

import { formatUsd } from "@/lib/money";

/**
 * How an app stands, as its row in Apps says it: the money the owner has there, if any, and one
 * word on what's in the way, if anything: something the owner has to give (amber, as everything
 * waiting on them is), the service's own trouble, or that it's off.
 */
export interface AppStanding {
  readonly money: string | null;
  readonly badge: {
    readonly tone: "waiting" | "loss" | "neutral";
    readonly says: string;
  } | null;
}

/** Dollars at an app worth showing: a cent or more. */
function dollarsThere(app: AppWire): string | null {
  const usd = app.account?.usd;
  return usd && Number(usd) >= 0.01 ? formatUsd(usd) : null;
}

/** The keys an app can't work without that it doesn't have yet. */
export function keysNeeded(app: AppWire): readonly AppSettingWire[] {
  // A wallet app that isn't the one in use lists its settings and needs none of them.
  if (app.needs.length === 0) return [];
  return app.settings.filter(({ kind, required, set }) => kind === "secret" && required && !set);
}

/**
 * What the owner is asked to paste, in a phrase: its one field's own name without the app's
 * ("bot token" for Telegram's bot token; an API key is just a key), or "keys".
 */
export function keysWord(app: Pick<AppWire, "name">, needed: readonly AppSettingWire[]): string {
  const [only] = needed;
  if (!only || needed.length > 1) return "keys";
  const own = only.label.startsWith(`${app.name} `)
    ? only.label.slice(app.name.length)
    : only.label;
  const word = own.replace(/\bAPI key\b/u, "key").trim();
  return word.charAt(0).toLowerCase() + word.slice(1);
}

/**
 * Whether an app shows only its key form, with no switch: it waits for keys and holds nothing of
 * the owner's, so saving them is the one thing to do. One holding money (or whose balance can't
 * be read) keeps its switch, the way to turn it off without giving the keys first.
 */
export function keysFirst(app: AppWire): boolean {
  if (keysNeeded(app).length === 0) return false;
  return app.account === null || (app.account.usd !== null && dollarsThere(app) === null);
}

/**
 * Which of an app's ways to try it work now, and which wait for what it still needs. With
 * nothing missing, all work. With something missing, none do, but for money already there:
 * Auni can read that, though a way that moves money still waits.
 */
export function waysToTry<Way extends { readonly title: string; readonly moves?: true }>(
  app: AppWire,
  ways: readonly Way[],
): { readonly now: readonly Way[]; readonly waiting: readonly Way[] } {
  const works = (way: Way) => app.needs.length === 0 || (app.account !== null && !way.moves);
  return { now: ways.filter(works), waiting: ways.filter((way) => !works(way)) };
}

/** One way money goes in or out: the app's own words, a tap asking Auni (which may wait), or nothing. */
export type MoneyWay = { readonly words: string } | { readonly waits: boolean } | null;

/**
 * Money in and out of an app with an account there, as its sheet says it. The app's words for
 * how money moves show only while it moves: until then the sheet says what's in the way instead,
 * and never how a buy spends cash while buying waits for keys. A way Auni is asked for keeps its
 * button, which waits too.
 */
export function moneyInOut(app: AppWire): {
  readonly in: MoneyWay;
  readonly out: MoneyWay;
  readonly blocked: string | null;
} | null {
  if (!app.account) return null;
  const keys = keysNeeded(app).length;
  const blocked =
    app.on && app.needs.length === 0
      ? null
      : !app.on
        ? `Turn ${app.name} on to move money here.`
        : keys > 0
          ? `Add your ${keys === 1 ? "key" : "keys"} above to move money here.`
          : `Auni can move money here once ${app.name} is set up.`;
  const way = (words: string | null): MoneyWay =>
    words === null ? { waits: blocked !== null } : blocked === null ? { words } : null;
  return { in: way(app.account.moneyIn), out: way(app.account.moneyOut), blocked };
}

/**
 * What it waits on, short enough for a tile: "Needs a key", "Needs 3 keys", "Not paired yet", or
 * what keeps going wrong for it now, "Out of credits".
 */
export function needOf(app: AppWire): string | null {
  const keys = keysNeeded(app).length;
  if (keys > 0) return keys === 1 ? "Needs a key" : `Needs ${keys} keys`;
  return app.needs[0] ?? app.troubles[0]?.short ?? null;
}

/**
 * What an app that is on still waits for before Auni can use it, said beside its switch: its
 * keys (whose fields sit above), or to be paired. Null when it waits for nothing more.
 */
export function waitingFor(app: AppWire): { readonly says: string; readonly under: string } | null {
  const keys = keysNeeded(app).length;
  if (keys > 0)
    return {
      says: keys === 1 ? "Waiting for your key" : "Waiting for your keys",
      // One with an account there is in use already: its keys add what it can do.
      under: `Auni ${app.account ? "can do more on" : "starts using"} ${app.name} once ${keys === 1 ? "it's" : "they're"} saved.`,
    };
  if (app.pairing === "ready")
    return {
      says: "Waiting to pair",
      under: "Pair it with your chat so Auni can answer you there.",
    };
  return app.needs[0] ? { says: "Not ready yet", under: app.needs[0] } : null;
}

export function appStanding(app: AppWire): AppStanding {
  const money = dollarsThere(app);
  if (!app.on) return { money, badge: { tone: "neutral", says: "Off" } };
  // What it needs is the owner's to give; a trouble is the service's own.
  if (app.needs.length > 0) return { money, badge: { tone: "waiting", says: needOf(app)! } };
  const trouble = app.troubles[0];
  if (trouble) return { money, badge: { tone: "loss", says: trouble.short } };
  if (app.account && app.account.usd === null)
    return { money, badge: { tone: "neutral", says: "Couldn't read balance" } };
  return { money, badge: null };
}
