import type { AppWire } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { appStanding, keysNeeded, needOf } from "./app-standing";
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

const account = (usd: string | null, specialists: string[] = []) => ({
  usd,
  holdings: [],
  specialists,
  moneyIn: null,
  moneyOut: null,
});

describe("appStanding", () => {
  it("says what keeps going wrong for an app that is ready otherwise, as its key running out of credits", () => {
    const outOfCredits = {
      short: "Out of credits",
      says: "Venue said its account is out of credits.",
    };
    expect(appStanding(app({ troubles: [outOfCredits] }))).toEqual({
      tone: "needs",
      says: "Out of credits",
      under: "Open it to see why",
      setUp: false,
    });
    expect(needOf(app({ troubles: [outOfCredits], account: account("5") }))).toBe("Out of credits");
  });

  it("offers Set up only for what the owner has left to give, never for a trouble of the service's own", () => {
    // A tile whose app kept failing said "Not working" with a "Set up" button beside it
    // (2026-11-14), though there was nothing to set up.
    const failing = { short: "Not working", says: "Reading its statement failed at 12:55 AM." };
    expect(appStanding(app({ troubles: [failing] })).setUp).toBe(false);
    expect(appStanding(app({ troubles: [failing], account: account("5") })).setUp).toBe(false);
    expect(appStanding(app({ needs: ["Needs an API key"], settings: [KEY] })).setUp).toBe(true);
    expect(appStanding(app({ needs: ["Not paired yet"], pairing: "ready" })).setUp).toBe(true);
    // Something to give and a trouble too: there is still something to set up.
    expect(
      appStanding(app({ needs: ["Needs an API key"], settings: [KEY], troubles: [failing] })),
    ).toMatchObject({ says: "Needs a key", setUp: true });
    // Money there, and a key still missing.
    expect(
      appStanding(app({ account: account("5"), needs: ["Needs an API key"], settings: [KEY] }))
        .setUp,
    ).toBe(true);
    expect(appStanding(app()).setUp).toBe(false);
    expect(
      appStanding(app({ on: false, needs: ["Needs an API key"], settings: [KEY] })).setUp,
    ).toBe(false);
  });

  it("says the money there before anything else, with what it still needs under it", () => {
    expect(appStanding(app({ account: account("412.18") }))).toEqual({
      tone: "money",
      says: "$412.18",
      under: "there now",
      setUp: false,
    });
    expect(
      appStanding(
        app({ account: account("408.58"), needs: ["Needs an API key"], settings: [KEY] }),
      ),
    ).toEqual({ tone: "money", says: "$408.58", under: "Needs a key", setUp: true });
  });

  it("says the one thing it needs when nothing is there", () => {
    expect(appStanding(app({ needs: ["Needs an API key"], settings: [KEY] }))).toMatchObject({
      tone: "needs",
      says: "Needs a key",
    });
    expect(
      needOf(
        app({
          needs: ["Needs an API key", "Needs a secret"],
          settings: [KEY, { ...KEY, key: "secret" }],
        }),
      ),
    ).toBe("Needs 2 keys");
    // What isn't a key is said as core said it.
    expect(needOf(app({ needs: ["Not paired yet"], pairing: "ready" }))).toBe("Not paired yet");
    // A wallet app that isn't the one in use lists settings and needs none of them.
    expect(needOf(app({ settings: [KEY], inUse: false }))).toBeNull();
    // Only a secret is typed into the app: a setting the owner's file alone sets is never asked for here.
    const file = { ...KEY, key: "appId", kind: "file", field: null } as const;
    expect(
      keysNeeded(app({ needs: ["Needs an app ID", "Needs an API key"], settings: [file, KEY] })),
    ).toEqual([KEY]);
  });

  it("never shows nothing there as a figure, nor an account it couldn't read as empty", () => {
    expect(appStanding(app({ account: account("0.00") }))).toEqual({
      tone: "ready",
      says: "Ready",
      under: "Nothing there yet",
      setUp: false,
    });
    expect(appStanding(app({ account: account(null) }))).toEqual({
      tone: "ready",
      says: "On",
      under: "Couldn't read it just now",
      setUp: false,
    });
    expect(appStanding(app({ standing: "Paired with your chat" }))).toMatchObject({
      under: "Paired with your chat",
    });
    expect(appStanding(app())).toMatchObject({ says: "Ready", under: "Auni can use it" });
  });

  it("says off, and that the money is still there", () => {
    expect(appStanding(app({ on: false }))).toEqual({
      tone: "off",
      says: "Off",
      under: "Auni doesn't use it",
      setUp: false,
    });
    expect(appStanding(app({ on: false, account: account("212") }))).toMatchObject({
      under: "$212 still there",
    });
  });
});

describe("turningOff", () => {
  it("flips at once when nothing of the owner's sits there", () => {
    expect(turningOff(app(), "Venue")).toEqual({ kind: "free" });
    expect(turningOff(app({ account: account("0.004") }), "Venue")).toEqual({ kind: "free" });
    // What couldn't be read is core's to judge as it decides.
    expect(turningOff(app({ account: account(null) }), "Venue")).toEqual({ kind: "free" });
  });

  it("first says what off means when money sits there, naming who of the team stops", () => {
    expect(turningOff(app({ account: account("212", ["Chips"]) }), "Venue")).toEqual({
      kind: "question",
      title: "Turn Venue off?",
      says: [
        "Auni will stop acting there, and Chips, your specialist with money there, will stop too.",
        "Your $212 stays yours and stays in your portfolio, and anything you already allowed still finishes.",
      ],
    });
    const two = turningOff(app({ account: account("212", ["Chips", "Rates"]) }), "Venue");
    expect(two).toMatchObject({
      says: [
        "Auni will stop acting there, and Chips and Rates, your specialists with money there, will stop too.",
        expect.any(String),
      ],
    });
    expect(turningOff(app({ account: account("212") }), "Venue")).toMatchObject({
      says: ["Auni will stop acting there.", expect.any(String)],
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
