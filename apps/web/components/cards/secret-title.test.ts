import { describe, expect, it } from "vitest";

import { secretTitle } from "@auni/shared";

describe("secretTitle", () => {
  it("asks for a service's key by its name, not its plumbing", () => {
    expect(secretTitle("Elfa API key")).toBe("Paste your Elfa key");
    expect(secretTitle("Solana private key")).toBe("Paste your Solana private key");
  });

  it("reads a plain field as a phrase", () => {
    expect(secretTitle("Sign-in code")).toBe("Paste your sign-in code");
    expect(secretTitle("Builder API key")).toBe("Paste your builder key");
    expect(secretTitle("Your keys")).toBe("Paste your keys");
  });
});
