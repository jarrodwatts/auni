import { describe, expect, it } from "vitest";

import { findSiteMark, markAddresses } from "./site-marks.ts";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** Google as it answers: a mark for the addresses in `has`, its 404 stand-in for any other. */
function google(has: readonly string[]) {
  const asked: string[] = [];
  const get = (url: string) => {
    const address = new URL(url).searchParams.get("url") ?? "";
    asked.push(address);
    return Promise.resolve(new Response(PNG_BYTES, { status: has.includes(address) ? 200 : 404 }));
  };
  return { asked, get };
}

describe("markAddresses", () => {
  it("tries the site by https then http, then the site it sits under", () => {
    expect(markAddresses("rbccm.com")).toEqual(["https://rbccm.com", "http://rbccm.com"]);
    expect(markAddresses("ir.williams.com")).toEqual([
      "https://ir.williams.com",
      "http://ir.williams.com",
      "https://williams.com",
      "http://williams.com",
    ]);
  });
});

describe("findSiteMark", () => {
  it("finds a mark Google files under http only", async () => {
    const { asked, get } = google(["http://rbccm.com"]);
    expect([...(await findSiteMark("rbccm.com", get))!]).toEqual([...PNG_BYTES]);
    expect(asked).toEqual(["https://rbccm.com", "http://rbccm.com"]);
  });

  it("falls back to the site a subdomain sits under", async () => {
    const { get } = google(["https://williams.com"]);
    expect([...(await findSiteMark("ir.williams.com", get))!]).toEqual([...PNG_BYTES]);
  });

  it("is null where Google has none, or answers with something other than a picture", async () => {
    expect(await findSiteMark("nothing-here.example", google([]).get)).toBeNull();
    const html = () => Promise.resolve(new Response("<html>", { status: 200 }));
    expect(await findSiteMark("cnbc.com", html)).toBeNull();
    const down = () => Promise.reject(new Error("offline"));
    expect(await findSiteMark("cnbc.com", down)).toBeNull();
  });
});
