import { describe, expect, it } from "vitest";

import { browserName, lastSeen } from "./sessions";

describe("a signed-in browser, as Settings names it", () => {
  it("says which browser on which device", () => {
    expect(
      browserName(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iPhone");
    expect(
      browserName(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
      ),
    ).toBe("Chrome on Mac");
    expect(browserName("curl/8.18.0")).toBe("A browser");
    expect(browserName(null)).toBe("A browser");
  });

  it("says when it was last used in words", () => {
    const now = Date.parse("2026-11-11T12:00:00Z");
    expect(lastSeen("2026-11-11T11:59:30Z", now)).toBe("Active now");
    expect(lastSeen("2026-11-11T11:30:00Z", now)).toBe("Last used 30 minutes ago");
    expect(lastSeen("2026-11-11T11:00:00Z", now)).toBe("Last used an hour ago");
    expect(lastSeen("2026-11-10T11:00:00Z", now)).toBe("Last used yesterday");
    expect(lastSeen("2026-11-08T11:00:00Z", now)).toBe("Last used 3 days ago");
  });
});
