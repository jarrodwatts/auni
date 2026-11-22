import type { WatchedWallet } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { appendWatchedWallet, normalizeXHandle, resolveWatchedWallet } from "./signals.ts";

describe("normalizeXHandle", () => {
  it("normalizes @handles, bare handles, and x.com / twitter.com URLs", () => {
    expect(normalizeXHandle("@VitalikButerin")).toBe("vitalikbuterin");
    expect(normalizeXHandle("  @@jarrod_watts  ")).toBe("jarrod_watts");
    expect(normalizeXHandle("https://x.com/jarrod_watts/status/123")).toBe("jarrod_watts");
    expect(normalizeXHandle("https://www.twitter.com/Auni_Agent?s=20")).toBe("auni_agent");
  });

  it("rejects empty or invalid handles", () => {
    expect(normalizeXHandle("")).toBeNull();
    expect(normalizeXHandle("   ")).toBeNull();
    expect(normalizeXHandle("has space")).toBeNull();
    expect(normalizeXHandle("toolonghandle12345")).toBeNull();
    expect(normalizeXHandle("bad-dash")).toBeNull();
  });
});

describe("appendWatchedWallet", () => {
  const wallet = (i: number, label: string | null = null) => ({
    address: `0x000000000000000000000000000000000000000${i}`,
    chain: "evm" as const,
    label,
  });

  it("deduplicates EVM addresses case-insensitively and updates label", () => {
    const first = appendWatchedWallet([], wallet(1, null));
    const updated = appendWatchedWallet(first, {
      address: wallet(1).address.toUpperCase(),
      chain: "evm",
      label: "Main",
    });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.label).toBe("Main");
  });

  it("enforces the 5-wallet cap", () => {
    let list: WatchedWallet[] = [wallet(1), wallet(2), wallet(3), wallet(4), wallet(5)];
    expect(() => appendWatchedWallet(list, wallet(6))).toThrow(/up to 5/iu);
    // Updating an existing entry when at the cap still succeeds.
    list = appendWatchedWallet(list, wallet(5, "Vault"));
    expect(list).toHaveLength(5);
    expect(list[4]?.label).toBe("Vault");
  });

  it("treats Solana Base58 addresses as case-sensitive", () => {
    const a: WatchedWallet = {
      address: "So11111111111111111111111111111111111111112",
      chain: "solana",
      label: "A",
    };
    const b: WatchedWallet = {
      address: "so11111111111111111111111111111111111111112",
      chain: "solana",
      label: "B",
    };
    const both = appendWatchedWallet([a], b);
    expect(both).toHaveLength(2);
  });
});

describe("resolveWatchedWallet", () => {
  it("accepts valid 32-byte Solana public keys and rejects malformed Base58 strings", async () => {
    await expect(
      resolveWatchedWallet("So11111111111111111111111111111111111111112", "Sol"),
    ).resolves.toEqual({
      address: "So11111111111111111111111111111111111111112",
      chain: "solana",
      label: "Sol",
    });
    // 44 Base58 '1's decode to 44 zero bytes, not a 32-byte Ed25519 public key.
    await expect(resolveWatchedWallet("1".repeat(44))).rejects.toThrow(/valid EVM address/iu);
  });
});
