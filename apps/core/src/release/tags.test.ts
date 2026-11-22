import { describe, expect, it } from "vitest";

import { byRelease, isReleaseTag } from "./tags.ts";

describe("release tags", () => {
  it("orders by number, not by text", () => {
    expect(["v0.9.3", "v0.10.0", "v0.2.11"].sort(byRelease)).toEqual([
      "v0.2.11",
      "v0.9.3",
      "v0.10.0",
    ]);
    expect(byRelease("v1.0.0", "v0.99.99")).toBeGreaterThan(0);
  });

  it("takes no pre-release or anything else for a release", () => {
    for (const tag of ["v0.2.0-rc.1", "latest", "0.3.0", "v0.4"])
      expect(isReleaseTag(tag)).toBe(false);
    expect(isReleaseTag("v0.1.0")).toBe(true);
  });
});
