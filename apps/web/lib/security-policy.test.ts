import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy, nonceOf } from "./security-policy";

describe("nonceOf", () => {
  it("reads back the nonce a policy was built with", () => {
    const nonce = "MDAwMDAwMDAtMDAwMC0wMDAw";
    expect(nonceOf(buildContentSecurityPolicy(nonce, false))).toBe(nonce);
  });

  it("is nothing where there is no policy", () => {
    expect(nonceOf(null)).toBeUndefined();
    expect(nonceOf("default-src 'self'")).toBeUndefined();
  });
});
