import type { IncomingMessage } from "node:http";

import { describe, expect, it } from "vitest";

import { theBox } from "../agent/box.ts";
import { doorSocket, ownerRefusal } from "./tailscale.ts";

const OWNER = "owner@example.com";
/** This machine's own tailnet address, as the test machine has it. */
const SELF = "100.70.0.1";
const ownAddress = (address: string) => address === SELF || address === "fd7a:115c:a1e0::1";

/** A request's headers as Node keeps each line of them (headersDistinct). */
function sent(headers: Record<string, string[]>): Pick<IncomingMessage, "headersDistinct"> {
  return { headersDistinct: headers };
}
const fromPhone = (login: string[] = [OWNER], from: string[] = ["100.70.0.2"]) =>
  sent({ "tailscale-user-login": login, "x-forwarded-for": from });

// What `tailscale serve` sends, seen on this machine (2026-11-15): the sender's login in
// Tailscale-User-Login, with any the request brought dropped, and X-Forwarded-For set afresh to
// the sender's tailnet address; a tagged device gets no login at all.
describe("who the door lets in", () => {
  it("lets in the owner's login from another device on the tailnet", () => {
    expect(ownerRefusal(fromPhone(), OWNER, ownAddress)).toBeNull();
    // A login is an email address, which Tailscale may case as the sign-in did.
    expect(ownerRefusal(fromPhone(["Owner@Example.com"]), OWNER, ownAddress)).toBeNull();
  });

  it("refuses a request with no login: a tagged device, or one that didn't come through serve", () => {
    expect(ownerRefusal(sent({ "x-forwarded-for": ["100.70.0.2"] }), OWNER, ownAddress)).toBe(
      "no Tailscale login came with it",
    );
  });

  it("refuses a request with the login twice, even both the owner's", () => {
    expect(ownerRefusal(fromPhone([OWNER, OWNER]), OWNER, ownAddress)).toBe(
      "it came with more than one Tailscale login",
    );
    expect(ownerRefusal(fromPhone(["other@example.com", OWNER]), OWNER, ownAddress)).not.toBeNull();
  });

  it("refuses another login: someone the tailnet is shared with, or another of its users", () => {
    expect(ownerRefusal(fromPhone(["other@example.com"]), OWNER, ownAddress)).toBe(
      "it came from another Tailscale login",
    );
    expect(ownerRefusal(fromPhone([""]), OWNER, ownAddress)).not.toBeNull();
    expect(ownerRefusal(fromPhone([`${OWNER}.evil.example`]), OWNER, ownAddress)).not.toBeNull();
  });

  it("refuses this machine's own requests, which any process here could make", () => {
    for (const address of [SELF, "fd7a:115c:a1e0::1", "[fd7a:115c:a1e0::1]"])
      expect(ownerRefusal(fromPhone([OWNER], [address]), OWNER, ownAddress)).toBe(
        "it came from this machine itself",
      );
  });

  it("refuses a request that doesn't say the one address it came from", () => {
    for (const from of [[], ["100.70.0.2", "100.70.0.3"], ["100.70.0.2, 100.70.0.3"]])
      expect(ownerRefusal(fromPhone([OWNER], from), OWNER, ownAddress)).toBe(
        "it didn't say one address it came from",
      );
  });
});

describe("the door's socket", () => {
  it("sits in the data folder, which the agent's box hides whole", () => {
    const { hidden } = theBox([]);
    expect(hidden.some((folder) => doorSocket().startsWith(`${folder}/`))).toBe(true);
  });
});
