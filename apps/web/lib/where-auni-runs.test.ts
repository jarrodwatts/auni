import { describe, expect, it } from "vitest";

import { remoteMachine } from "./where-auni-runs";

describe("remoteMachine", () => {
  it("is none when Auni runs on this computer", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "auni.localhost"])
      expect(remoteMachine(host)).toBeNull();
  });

  it("is the machine's own name when the browser reached it over the network", () => {
    expect(remoteMachine("evo-t1.tail1234.ts.net")).toBe("evo-t1");
    expect(remoteMachine("Studio")).toBe("studio");
    expect(remoteMachine("100.101.2.3")).toBe("100.101.2.3");
  });
});
