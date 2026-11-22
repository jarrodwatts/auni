import { describe, expect, it, vi } from "vitest";

import type { WalletProvider } from "../apps/contract.ts";
import { paysOwnGas } from "./wallets.ts";

// The wallet app core uses, which a test chooses.
const chosen = vi.hoisted(() => ({ wallet: {} as Partial<WalletProvider> }));
vi.mock("../apps/registry.ts", () => ({ theWallet: () => chosen.wallet }));

describe("paysOwnGas", () => {
  it("is the wallet's own everywhere when it names no sponsor", async () => {
    chosen.wallet = {};
    for (const chain of [1, 143, "solana"] as const) expect(await paysOwnGas(chain)).toBe(true);
  });

  it("is the sponsor's wherever the wallet says one pays", async () => {
    chosen.wallet = { sponsored: (chain) => chain !== 1 };
    expect(await paysOwnGas(1)).toBe(true);
    expect(await paysOwnGas(143)).toBe(false);
    expect(await paysOwnGas("solana")).toBe(false);
  });
});
