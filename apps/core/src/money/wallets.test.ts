import { describe, expect, it, vi } from "vitest";

import { WalletExists, type WalletAddresses, type WalletProvider } from "../apps/contract.ts";
import { publishMe } from "../conversation/stream.ts";
import { makeWalletIfNone, paysOwnGas } from "./wallets.ts";

// The wallet app core uses, which a test chooses.
const chosen = vi.hoisted(() => ({ wallet: {} as Partial<WalletProvider> }));
vi.mock("../apps/registry.ts", () => ({ theWallet: () => chosen.wallet }));
vi.mock("../conversation/stream.ts", () => ({ publishMe: vi.fn() }));

const NONE: WalletAddresses = { evm: null, solana: null };
const MADE: WalletAddresses = { evm: "0x00000000000000000000000000000000000000e1", solana: "So1" };

/** A wallet app that makes one wallet alone, as local-key's and Privy's do, after `made` asks. */
function makesOne() {
  let held = NONE;
  const create = vi.fn(async () => {
    // Every ask has looked before any makes one, as two tabs opening Add money at once would.
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (held !== NONE) throw new WalletExists();
    held = MADE;
    return held;
  });
  return { addresses: async () => held, create };
}

describe("makeWalletIfNone", () => {
  it("makes the wallet when there's none, and tells the open tabs", async () => {
    const wallet = makesOne();
    chosen.wallet = wallet;
    vi.mocked(publishMe).mockClear();
    await makeWalletIfNone();
    expect(wallet.create).toHaveBeenCalledTimes(1);
    expect(await wallet.addresses()).toEqual(MADE);
    expect(publishMe).toHaveBeenCalledTimes(1);
  });

  it("makes none beside one already there", async () => {
    const create = vi.fn();
    chosen.wallet = { addresses: async () => MADE, create };
    await makeWalletIfNone();
    expect(create).not.toHaveBeenCalled();
  });

  // Add money open in two tabs on no wallet: both ask, one wallet is made, and neither fails.
  it("leaves one wallet, and no failure, when two ask at once", async () => {
    const wallet = makesOne();
    chosen.wallet = wallet;
    vi.mocked(publishMe).mockClear();
    await Promise.all([makeWalletIfNone(), makeWalletIfNone()]);
    expect(wallet.create).toHaveBeenCalledTimes(2);
    expect(await wallet.addresses()).toEqual(MADE);
    expect(publishMe).toHaveBeenCalledTimes(1);
  });

  it("says when the wallet couldn't be made", async () => {
    chosen.wallet = {
      addresses: async () => NONE,
      create: async () => {
        throw new Error("the keychain is locked");
      },
    };
    await expect(makeWalletIfNone()).rejects.toThrow("the keychain is locked");
  });
});

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
