import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { rentHeldBy } from "./rent.ts";

// The deposit Across built for the live bridge of 2026-11-16, $1.01 of USDC out of Solana, as
// the chain keeps it (finding 91): its CCTP burn made 4WggwDc8... for its message, the
// wallet 3Wk9gwrx... paying the rent.
const deposit = JSON.parse(
  readFileSync(new URL("fixtures/solana-deposit-2026-11-16.json", import.meta.url), "utf8"),
) as { transaction: string };
const WALLET = "3Wk9gwrx9TitcKoDZ68xfNscXdRNd5YNenRwp7SWsj4Q";

describe("the rent a deposit from Solana leaves with Circle", () => {
  it("is found in the deposit Across built, held for the wallet that paid it", () => {
    expect(rentHeldBy(deposit.transaction, WALLET)).toBe(
      "4WggwDc8tGnBsSRTUBLVDjhF1Pytrn258xWL2ZbknfC6",
    );
    // Rent another wallet paid is none of this one's to get back; bytes it can't read, none.
    expect(
      rentHeldBy(deposit.transaction, "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
    ).toBeNull();
    expect(rentHeldBy("not a transaction", WALLET)).toBeNull();
  });
});
