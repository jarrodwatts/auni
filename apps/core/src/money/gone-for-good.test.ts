import { describe, expect, it } from "vitest";

import { burns, goneForGood } from "./gone-for-good.ts";

const USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const FRIEND = "0x7777777777777777777777777777777777777777";

describe("burns", () => {
  it("knows the burn addresses in any case, and the precompiles every chain has", () => {
    for (const burnt of [
      "0x0000000000000000000000000000000000000000",
      "0x000000000000000000000000000000000000dEaD",
      "0x000000000000000000000000000000000000DEAD",
      "0xdead000000000000000042069420694206942069",
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000011",
      "0x0000000000000000000000000000000000000100",
      "1nc1nerator11111111111111111111111111111111",
    ])
      expect(burns(burnt)).toBe(true);
  });

  it("leaves a wallet, and a chain's own address that takes coin to do something", () => {
    // Monad's staking, and Arbitrum's ArbSys, which carries ETH home.
    for (const kept of [
      FRIEND,
      USDC,
      "0x0000000000000000000000000000000000001000",
      "0x0000000000000000000000000000000000000064",
      "11111111111111111111111111111111",
    ])
      expect(burns(kept)).toBe(false);
  });
});

describe("goneForGood", () => {
  it("says what nobody can spend from, and a token's own contract sent that token", () => {
    expect(goneForGood([FRIEND])).toBeNull();
    expect(goneForGood([USDC.toLowerCase()], [USDC])).toBe(
      "0x7547…b603 is the token's own contract, not a wallet. What this sends there is gone for good.",
    );
    expect(goneForGood([FRIEND, "0x000000000000000000000000000000000000dEaD"])).toBe(
      "0x0000…dEaD is a burn address: nobody can ever spend from it. What this sends there is gone for good.",
    );
  });
});
