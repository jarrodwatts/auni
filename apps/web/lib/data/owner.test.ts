import { describe, expect, it } from "vitest";

import { CoreApiError } from "@/lib/core";

import { refusedAs } from "./owner";

const refused = (code: string) => new CoreApiError({ message: "", status: 401, code });

describe("refusedAs", () => {
  it("tells an unpaired browser from one whose link was used", () => {
    expect(refusedAs(refused("pairing_required"), false)).toBe("unpaired");
    expect(refusedAs(refused("pairing_required"), true)).toBe("link-used");
  });

  it("never sends an always-on owner to pair, which can't help there", () => {
    expect(refusedAs(refused("tailscale_owner_only"), false)).toBe("tailscale-only");
    expect(refusedAs(refused("tailscale_owner_only"), true)).toBe("tailscale-only");
  });

  it("is nothing for an answer that isn't a refusal", () => {
    expect(refusedAs(new CoreApiError({ message: "", status: 503 }), false)).toBeNull();
    expect(refusedAs(new Error("offline"), false)).toBeNull();
  });
});
