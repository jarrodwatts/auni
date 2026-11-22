import { afterEach, describe, expect, it } from "vitest";

import type { AppSetting } from "@auni/shared";

import { defineApp } from "./apps/contract.ts";
import { connecting, connects, offerNamed } from "./connect.ts";

// What Auni may offer of an app, on apps made here: a key asked for in its private field, the
// app turned back on, and nothing a browser session must never reach.

const app = (settings: Record<string, AppSetting>) =>
  defineApp({ about: { id: "venue", name: "Venue", settings } });

const key = (env: string) =>
  ({ env, label: "Route API key", kind: "secret", required: true }) as const;

afterEach(() => {
  delete process.env.VENUE_API_KEY;
  delete process.env.VENUE_API_URL;
});

describe("connecting", () => {
  const key = {
    env: "VENUE_API_KEY",
    label: "Venue API key",
    kind: "secret",
    required: true,
  } as const;
  const url = {
    env: "VENUE_API_URL",
    label: "Venue API server",
    kind: "file",
    required: true,
  } as const;

  it("is an offer for an app that lacks a key the owner can type", () => {
    const venue = app({ apiKey: key });
    expect(connecting(venue, null)).toEqual({
      kind: "card",
      turnsOn: false,
      keys: ["Venue API key"],
    });
    process.env.VENUE_API_KEY = "k";
    expect(connecting(venue, null)).toEqual({ kind: "nothing" });
  });

  it("is never a card for a setting only the owner's file changes, even beside a key", () => {
    const venue = app({ apiKey: key, apiUrl: url });
    const state = connecting(venue, null);
    expect(state.kind).toBe("no-card");
    expect(state).toMatchObject({ why: expect.stringContaining("VENUE_API_URL") });
    // Once the file has it, the key alone is left, and a card can take that.
    process.env.VENUE_API_URL = "https://venue.example";
    expect(connecting(venue, null)).toMatchObject({ kind: "card", keys: ["Venue API key"] });
  });

  // Live, 2026-11-14: a switched-off Aave was offered as "Connect Aave", which reads as a key paste.
  it("is called for what it does: turned on", () => {
    const venue = app({ apiKey: key });
    expect(offerNamed(venue)).toEqual({ title: "Turn Venue on", button: "Turn Venue on" });
    expect(connects(venue)).toBe(
      "Auni can use Venue again, with its tools and what it knows of it. You can turn it off again under Apps.",
    );
    const long = defineApp({ about: { id: "long", name: "Hyperliquid Pro" } });
    expect(offerNamed(long).button).toBe("Turn on");
  });

  it("needs nothing typed for a setting an app can work without", () => {
    expect(connecting(app({ apiKey: { ...key, required: false } }), null)).toEqual({
      kind: "nothing",
    });
  });
});

describe("connecting a Solana route", () => {
  const route = defineApp({
    about: { id: "route", name: "Route", settings: { apiKey: key("ROUTE_API_KEY") } },
    solana: {} as never,
  });
  const evm = "0x00000000000000000000000000000000000000a1";

  // The AI offered Jupiter, to buy on Solana, to a wallet brought with its EVM key alone.
  it("is no card for a wallet with no Solana address, which it says how to add", () => {
    expect(connecting(route, { evm, solana: null })).toEqual({
      kind: "no-card",
      why: "Route trades on Solana, so it would add nothing yet. This wallet has no Solana address yet, so nothing can move on Solana. One can be added in Settings, under Wallet.",
    });
    expect(connecting(route, { evm, solana: "So1ana" })).toMatchObject({ kind: "card" });
    // Before there is a wallet, or where it can't be read, it is offered as before.
    expect(connecting(route, null)).toMatchObject({ kind: "card" });
    expect(connecting(route, { evm: null, solana: null })).toMatchObject({ kind: "card" });
  });
});
