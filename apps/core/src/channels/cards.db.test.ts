import { describe, expect, it } from "vitest";

import { env } from "../env.ts";
import { appDestination } from "./cards.ts";

describe("appDestination", () => {
  it("uses Tailscale's address only when Auni's door is configured", () => {
    const saved = { WEB_ORIGIN: env.WEB_ORIGIN, TAILSCALE_OWNER: env.TAILSCALE_OWNER };
    try {
      Object.assign(env, {
        WEB_ORIGIN: "https://evo-t1.example.ts.net",
        TAILSCALE_OWNER: undefined,
      });
      expect(appDestination("/app/chat/t")).toMatchObject({
        link: null,
        machine: expect.any(String),
      });

      Object.assign(env, { TAILSCALE_OWNER: "owner@example.com" });
      expect(appDestination("/app/chat/t")).toMatchObject({
        link: "https://evo-t1.example.ts.net/app/chat/t",
      });

      Object.assign(env, { WEB_ORIGIN: "https://localhost:3000" });
      expect(appDestination("/app/chat/t").link).toBeNull();
    } finally {
      Object.assign(env, saved);
    }
  });
});
