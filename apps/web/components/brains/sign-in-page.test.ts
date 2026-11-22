import { describe, expect, it } from "vitest";

import { signInPage } from "./sign-in-page";

describe("signInPage", () => {
  it("is the page Claude Code's sign-in printed", () => {
    const printed = [
      "Opening browser to sign in…",
      "If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&state=abc",
      "Paste code here if prompted >",
    ].join("\n");
    expect(signInPage(printed)).toBe("https://claude.ai/oauth/authorize?code=true&state=abc");
  });

  it("is the newest page when it printed more than one", () => {
    expect(signInPage("visit https://a.example/one\nthen https://b.example/two")).toBe(
      "https://b.example/two",
    );
  });

  it("is null before it has printed one, and never an address that isn't https", () => {
    expect(signInPage("Opening browser to sign in…")).toBeNull();
    expect(signInPage("visit http://localhost:54545/callback")).toBeNull();
  });
});
