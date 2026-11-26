import type { AppWire } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { appStanding, keysNeeded, moneyInOut, needOf, waysToTry } from "./app-standing";
import { turningOff } from "./turning-off";

const KEY = {
  key: "apiKey",
  label: "API key",
  kind: "secret",
  required: true,
  help: null,
  set: null,
  untried: false,
  field: "setting:venue:apiKey",
  env: "VENUE_API_KEY",
} as const;

function app(fields: Partial<AppWire> = {}): AppWire {
  return {
    id: "venue",
    name: "Venue",
    does: "Trade there",
    canSwitch: true,
    on: true,
    jobs: [],
    inUse: true,
    standing: null,
    needs: [],
    pairing: null,
    troubles: [],
    settings: [],
    account: null,
    stays: null,
    ...fields,
  };
}

const account = (usd: string | null) => ({
  usd,
  holdings: [],
  moneyIn: null,
  moneyOut: null,
});

describe("appStanding", () => {
  it("says the money there, with nothing beside it when nothing's in the way", () => {
    expect(appStanding(app({ account: account("412.18") }))).toEqual({
      money: "$412.18",
      badge: null,
    });
    // Nothing there, or less than a cent, is no figure at all.
    expect(appStanding(app({ account: account("0.004") }))).toEqual({ money: null, badge: null });
    expect(appStanding(app())).toEqual({ money: null, badge: null });
  });

  it("says what the owner still has to give in amber, with the money there beside it", () => {
    expect(
      appStanding(
        app({ account: account("408.58"), needs: ["Needs an API key"], settings: [KEY] }),
      ),
    ).toEqual({ money: "$408.58", badge: { tone: "waiting", says: "Needs a key" } });
    expect(
      appStanding(
        app({
          needs: ["Needs an API key", "Needs a secret"],
          settings: [KEY, { ...KEY, key: "secret" }],
        }),
      ).badge,
    ).toEqual({ tone: "waiting", says: "Needs 2 keys" });
    // What isn't a key is said as core said it.
    expect(appStanding(app({ needs: ["Not paired yet"], pairing: "ready" })).badge).toEqual({
      tone: "waiting",
      says: "Not paired yet",
    });
  });

  it("says the service's own trouble as a failure, never as something for the owner to set up", () => {
    // A tile whose app kept failing said "Not working" with a "Set up" button beside it
    // (2026-11-14), though there was nothing to set up.
    const failing = { short: "Not working", says: "Reading its statement failed at 12:55 AM." };
    expect(appStanding(app({ troubles: [failing], account: account("5") }))).toEqual({
      money: "$5",
      badge: { tone: "loss", says: "Not working" },
    });
    // Something to give and a trouble too: what's the owner's to give comes first.
    expect(
      appStanding(app({ needs: ["Needs an API key"], settings: [KEY], troubles: [failing] })).badge,
    ).toEqual({ tone: "waiting", says: "Needs a key" });
  });

  it("says off, and keeps the money there in view", () => {
    expect(appStanding(app({ on: false, account: account("212") }))).toEqual({
      money: "$212",
      badge: { tone: "neutral", says: "Off" },
    });
    // Off, a key it lacks is nothing to chase.
    expect(
      appStanding(app({ on: false, needs: ["Needs an API key"], settings: [KEY] })).badge,
    ).toEqual({
      tone: "neutral",
      says: "Off",
    });
  });

  it("never shows an account it couldn't read as empty", () => {
    expect(appStanding(app({ account: account(null) }))).toEqual({
      money: null,
      badge: { tone: "neutral", says: "Couldn't read balance" },
    });
  });

  it("needs only the keys typed into the app, and none for a wallet app not in use", () => {
    expect(needOf(app({ settings: [KEY], inUse: false }))).toBeNull();
    const file = { ...KEY, key: "appId", kind: "file", field: null } as const;
    expect(
      keysNeeded(app({ needs: ["Needs an app ID", "Needs an API key"], settings: [file, KEY] })),
    ).toEqual([KEY]);
  });
});

describe("waysToTry", () => {
  const read = { title: "What are people betting on?" };
  const bet = { title: "Bet $20 on something I believe", moves: true } as const;
  const titles = ({ now, waiting }: ReturnType<typeof waysToTry<{ readonly title: string }>>) => ({
    now: now.map(({ title }) => title),
    waiting: waiting.map(({ title }) => title),
  });

  it("offers every way once nothing is missing", () => {
    expect(titles(waysToTry(app(), [read, bet]))).toEqual({
      now: [read.title, bet.title],
      waiting: [],
    });
  });

  // Polymarket with $408.58 and no keys offered "Bet $20" and "Take money out", neither of
  // which can work until its keys are in (2026-11-25).
  it("keeps a way that moves money waiting for the keys, even with money there", () => {
    const needsKeys = { needs: ["Needs an API key"], settings: [KEY] };
    expect(
      titles(waysToTry(app({ ...needsKeys, account: account("408.58") }), [read, bet])),
    ).toEqual({ now: [read.title], waiting: [bet.title] });
    // With no money there, there's nothing to read yet either.
    expect(titles(waysToTry(app(needsKeys), [read, bet]))).toEqual({
      now: [],
      waiting: [read.title, bet.title],
    });
  });
});

describe("moneyInOut", () => {
  const polymarket = (fields: Partial<AppWire> = {}) =>
    app({
      name: "Polymarket",
      account: {
        ...account("408.58"),
        moneyIn: "A buy spends the cash already in your Polymarket wallet first.",
      },
      ...fields,
    });

  it("says how money moves there, and offers what Auni is asked for, once it can", () => {
    expect(moneyInOut(polymarket())).toEqual({
      in: { words: "A buy spends the cash already in your Polymarket wallet first." },
      out: { waits: false },
      blocked: null,
    });
    expect(moneyInOut(app())).toBeNull();
  });

  // Polymarket with money and no keys still explained how a buy spends its cash, while buying
  // waited for those keys (2026-11-25).
  it("says only what's in the way until money can move there", () => {
    expect(moneyInOut(polymarket({ needs: ["Needs an API key"], settings: [KEY] }))).toEqual({
      in: null,
      out: { waits: true },
      blocked: "Add your key above to move money here.",
    });
    expect(moneyInOut(polymarket({ on: false }))?.blocked).toBe(
      "Turn Polymarket on to move money here.",
    );
    expect(moneyInOut(polymarket({ needs: ["Not paired yet"] }))?.blocked).toBe(
      "Auni can move money here once Polymarket is set up.",
    );
  });
});

describe("turningOff", () => {
  it("flips at once when nothing of the owner's sits there", () => {
    expect(turningOff(app(), "Venue")).toEqual({ kind: "free" });
    expect(turningOff(app({ account: account("0.004") }), "Venue")).toEqual({ kind: "free" });
    // What couldn't be read is core's to judge as it decides.
    expect(turningOff(app({ account: account(null) }), "Venue")).toEqual({ kind: "free" });
  });

  it("first says what off means when money sits there", () => {
    expect(turningOff(app({ account: account("212") }), "Venue")).toEqual({
      kind: "question",
      title: "Turn Venue off?",
      says: [
        "Auni will stop acting there.",
        "Your $212 stays yours, and anything you already allowed still finishes.",
      ],
    });
  });

  it("says why it can't be turned off, and how to change that, before anything is asked of core", () => {
    const stays =
      "You have 2 leveraged positions open there, and Auni has to be able to close them.";
    expect(turningOff(app({ account: account("900"), stays }), "Venue")).toEqual({
      kind: "refused",
      title: "Venue can't be turned off yet",
      why: stays,
      fix: "Close every position I have open on Venue.",
    });
  });
});
