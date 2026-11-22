import { describe, expect, it } from "vitest";

import { pairingCodeIn } from "./pairing";

describe("pairingCodeIn", () => {
  it("reads the code a pairing link carries in its fragment", () => {
    expect(pairingCodeIn("#pair=Ab3_x-9")).toBe("Ab3_x-9");
    expect(pairingCodeIn("pair=Ab3_x-9")).toBe("Ab3_x-9");
  });

  it("reads nothing from any other fragment", () => {
    for (const hash of ["", "#", "#pair=", "#step=wallet", "#pair=a%20b", "#pair=<script>"])
      expect(pairingCodeIn(hash)).toBeNull();
  });
});
