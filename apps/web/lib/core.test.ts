import { afterEach, describe, expect, it, vi } from "vitest";

import { CoreApiError, requestCore } from "./core";

afterEach(() => vi.unstubAllGlobals());

describe("requestCore", () => {
  it("calls core through this site's /core, so the owner's cookie rides along and nothing else", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      requestCore("me", { method: "PATCH", body: JSON.stringify({ name: "Jo" }) }),
    ).resolves.toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/core/me");
    expect(init.credentials).toBe("same-origin");
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("authorization")).toBe(false);
  });

  it("says a browser that isn't paired with core's own reason", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: "pairing_required" }, { status: 401 }),
    );
    const refused = await requestCore("me").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(CoreApiError);
    expect(refused).toMatchObject({ status: 401, code: "pairing_required" });
  });
});
