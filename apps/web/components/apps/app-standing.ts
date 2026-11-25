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
 * What it waits on, short enough for a tile: "Needs a key", "Needs 3 keys", "Not paired yet", or
 * what keeps going wrong for it now, "Out of credits".
 */
export function needOf(app: AppWire): string | null {
  const keys = keysNeeded(app).length;
  if (keys > 0) return keys === 1 ? "Needs a key" : `Needs ${keys} keys`;
  return app.needs[0] ?? app.troubles[0]?.short ?? null;
}

/**
 * What an app that is on still waits for before Auni can use it, other than its keys (whose own
 * fields say so, in place of its switch): "On, but waiting to be paired". Null when it waits for
 * nothing more.
 */
export function waitingFor(app: AppWire): { readonly says: string; readonly under: string } | null {
  if (keysNeeded(app).length > 0) return null;
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
