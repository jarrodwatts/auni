import { describe, expect, it } from "vitest";

import { CoreApiError, requestCore } from "@/lib/core";

import { refusedAs } from "./owner";

const refused = (code: string, at?: string) =>
  new CoreApiError({ message: "", status: 401, code, ...(at ? { at } : {}) });

describe("refusedAs", () => {
  it("tells an unpaired browser from one whose link was used", () => {
    expect(refusedAs(refused("pairing_required"), false)).toEqual({ status: "unpaired" });
    expect(refusedAs(refused("pairing_required"), true)).toEqual({ status: "link-used" });
  });

  it("never sends an always-on owner to pair, which can't help there", () => {
    const at = "https://box.tailnet-example.ts.net";
    expect(refusedAs(refused("tailscale_owner_only", at), false)).toEqual({
      status: "tailscale-only",
      at,
    });
    expect(refusedAs(refused("tailscale_owner_only", at), true)).toEqual({
      status: "tailscale-only",
      at,
    });
  });

  it("parses the address core says an always-on Auni opens at", async () => {
    const answer = new Response(
      JSON.stringify({ error: "tailscale_owner_only", at: "https://box.tailnet-example.ts.net" }),
      { status: 401 },
    );
    const real = globalThis.fetch;
    globalThis.fetch = async () => answer;
    try {
      const error = await requestCore("me").catch((thrown: unknown) => thrown);
      expect(refusedAs(error, false)).toEqual({
        status: "tailscale-only",
        at: "https://box.tailnet-example.ts.net",
      });
    } finally {
      globalThis.fetch = real;
    }
  });

  it("is nothing for an answer that isn't a refusal", () => {
    expect(refusedAs(new CoreApiError({ message: "", status: 503 }), false)).toBeNull();
    expect(refusedAs(new Error("offline"), false)).toBeNull();
  });
});
