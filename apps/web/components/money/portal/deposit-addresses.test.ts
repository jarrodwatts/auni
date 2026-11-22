import { describe, expect, it } from "vitest";

import type { DepositNetwork } from "@/lib/data/portfolio";

import { depositAddresses, networkNames, shortAddress, watchedTokens } from "./deposit-addresses";

const EVM = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
const CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const SOLANA = "7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV";

function network(key: DepositNetwork["key"], networkName: string, address: string) {
  return {
    key,
    networkName,
    logo: `/brand/chains/${key}.svg`,
    chainId: null,
    address,
  } satisfies DepositNetwork;
}

const monad = network("monad", "Monad", EVM);
const base = network("base", "Base", EVM);
const solana = network("solana", "Solana", SOLANA);

describe("depositAddresses", () => {
  it("gives every EVM network one checksummed address, and Solana its own", () => {
    expect(depositAddresses([monad, base, solana])).toEqual([
      { address: CHECKSUMMED, networks: [monad, base] },
      { address: SOLANA, networks: [solana] },
    ]);
  });

  it("folds an address however its case was written", () => {
    const shouting = network("base", "Base", CHECKSUMMED);
    expect(depositAddresses([monad, shouting])).toEqual([
      { address: CHECKSUMMED, networks: [monad, shouting] },
    ]);
  });

  it("offers nothing while no wallet is ready", () => {
    expect(depositAddresses([])).toEqual([]);
  });
});

describe("networkNames", () => {
  it("reads as a sentence", () => {
    expect(networkNames([monad])).toBe("Monad");
    expect(networkNames([monad, base])).toBe("Monad and Base");
    expect(networkNames([monad, base, solana])).toBe("Monad, Base and Solana");
  });

  it("offers a choice when asked to", () => {
    expect(networkNames([monad, base, solana], "or")).toBe("Monad, Base or Solana");
  });
});

describe("shortAddress", () => {
  it("keeps the ends people check", () => {
    expect(shortAddress(CHECKSUMMED)).toBe("0x5aAe…eAed");
    expect(shortAddress(SOLANA)).toBe("7EcD…FLtV");
  });
});

describe("watchedTokens", () => {
  it("shows the contract a token is watched for, and leaves a token named alone to the title", () => {
    expect(
      watchedTokens([
        { name: "USDC", address: null },
        { name: "STANDARD", address: "0x88ad09518695c6c3712AC10a214bE5109a655671" },
        { name: "BONK", address: SOLANA },
      ]),
    ).toEqual(["STANDARD at 0x88ad…5671", "BONK at 7EcD…FLtV"]);
    expect(watchedTokens([{ name: "USDC", address: null }])).toEqual([]);
  });
});
