import { vi } from "vitest";

import { defineApp } from "../../apps/contract.ts";
import { ABOUT } from "./about.ts";

/**
 * A vault whose shares are a token in the owner's wallet on Base that no public price feed lists.
 * Core reads the balance as it reads any wallet token, and the vault says what a share is worth.
 */
export const VAULT = ABOUT.vault.id;
export const VAULT_SHARES = {
  chain: "base",
  instrument: "0x000000000000000000000000000000000000fd01",
  symbol: "fvSHARE",
} as const;

/** What one whole share redeems for now, in dollars, which a test may change. */
export const sharePrice = vi.fn(async (): Promise<number | undefined> => 1.035);

const prices = { live: sharePrice, history: async () => [] };

export default defineApp({
  about: ABOUT.vault,
  // Kept in the wallet: core reads the balance, and the account says what a share is and is worth.
  account: {
    kept: { wallet: [VAULT_SHARES] },
    prices,
    face: async (holding) => ({
      name: "Fake Vault",
      detail: `${holding.quantity} shares`,
      logoUrl: null,
    }),
    moneyIn: "Fake Vault takes deposits on its own site.",
    moneyOut: "Fake Vault redeems shares on its own site.",
  },
});
