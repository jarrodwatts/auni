import { describe, expect, it } from "vitest";

import { EVM_NATIVE, evmTokenKey } from "./fill-key.ts";

describe("evmTokenKey", () => {
  it("names a chain's own coin as itself, by any address it goes by", () => {
    expect(evmTokenKey("base", EVM_NATIVE).instrument).toBe("native");
    expect(evmTokenKey("base", "0x0000000000000000000000000000000000000000").instrument).toBe(
      "native",
    );
    // Polygon's POL as a token is the coin: its balance is the coin's balance.
    expect(evmTokenKey("polygon", "0x0000000000000000000000000000000000001010").instrument).toBe(
      "native",
    );
    // Elsewhere that address is no coin of the chain's.
    expect(evmTokenKey("base", "0x0000000000000000000000000000000000001010").instrument).toBe(
      "0x0000000000000000000000000000000000001010",
    );
  });
});
