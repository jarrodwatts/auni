import type { AppSettingWire, AppWire } from "@auni/shared";

import { formatUsd } from "@/lib/money";

/**
 * How an app stands, as its tile says it in two lines: one thing in words (the money the owner
 * has there, the one thing it still needs, or that it is off) over a quieter line.
 */
export interface AppStanding {
  /** money: dollars there. ready: nothing to do. needs: it waits on the owner. off: turned off. */
  readonly tone: "money" | "ready" | "needs" | "off";
  readonly says: string;
  readonly under: string;
  /**
   * Whether the owner has something left to give it (a key, a pairing), which its tile offers
   * as "Set up". A trouble is the service's own: there is nothing of theirs to set up for it.
   */
  readonly setUp: boolean;
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
 * What it waits on, short enough for a tile: "Needs a key", "Needs 3 keys", "Not paired yet", or
 * what keeps going wrong for it now, "Out of credits".
 */
export function needOf(app: AppWire): string | null {
  const keys = keysNeeded(app).length;
  if (keys > 0) return keys === 1 ? "Needs a key" : `Needs ${keys} keys`;
  return app.needs[0] ?? app.troubles[0]?.short ?? null;
}

/**
 * What an app that is on still waits for before Auni can use it, as its switch says it: "On, but
 * waiting for its key" over "Auni will use it once that is in." Null when it waits for nothing.
 */
export function waitingFor(app: AppWire): { readonly says: string; readonly under: string } | null {
  const keys = keysNeeded(app).length;
  if (keys === 1)
    return { says: "On, but waiting for its key", under: "Auni will use it once that is in." };
  if (keys > 1)
    return {
      says: `On, but waiting for its ${keys} keys`,
      under: "Auni will use it once they are in.",
    };
  if (app.pairing === "ready")
    return {
      says: "On, but waiting to be paired",
      under: "Auni will answer you there once it is.",
    };
  return app.needs[0] ? { says: "On, but not ready yet", under: app.needs[0] } : null;
}

export function appStanding(app: AppWire): AppStanding {
  const there = dollarsThere(app);
  const need = needOf(app);
  // What it needs is the owner's to give; a trouble is the service's, said in its sheet.
  const setUp = app.on && app.needs.length > 0;
  if (!app.on)
    return {
      tone: "off",
      says: "Off",
      under: there ? `${there} still there` : "Auni doesn't use it",
      setUp,
    };
  if (there) return { tone: "money", says: there, under: need ?? "there now", setUp };
  if (need)
    return {
      tone: "needs",
      says: need,
      under: setUp ? "Open it to finish" : "Open it to see why",
      setUp,
    };
  if (app.account && app.account.usd === null)
    return { tone: "ready", says: "On", under: "Couldn't read it just now", setUp };
  return {
    tone: "ready",
    says: "Ready",
    under: app.standing ?? (app.account ? "Nothing there yet" : "Auni can use it"),
    setUp,
  };
}
