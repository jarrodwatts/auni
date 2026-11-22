import { existsSync } from "node:fs";

import { NETWORK_KEYS, NETWORKS } from "@auni/shared";
import { describe, expect, it } from "vitest";
import { depositNetworks } from "./portfolio";
import { WITHDRAW_NETWORKS } from "./withdrawals";

const EVM = "0x1111111111111111111111111111111111111111";
const SOLANA = "So11111111111111111111111111111111111111112";

const shipped = (logo: string) => existsSync(new URL(`../../public${logo}`, import.meta.url));

describe("the web's networks", () => {
  // Core runs only on mainnet, so the add-money screen must never send the owner to a testnet,
  // whatever the build or its settings.
  it("takes money in on every network Auni watches, never a testnet, Solana last", () => {
    const deposits = depositNetworks({ evm: EVM, solana: SOLANA });
    expect(deposits.map(({ key }) => key)).toEqual(NETWORK_KEYS);
    expect(deposits.at(-1)?.key).toBe("solana");
    for (const { key, logo, chainId, address } of deposits) {
      expect(NETWORKS[key].viem?.testnet ?? false, key).toBe(false);
      expect(chainId, key).toBe(NETWORKS[key].viem?.id ?? null);
      expect(shipped(logo), logo).toBe(true);
      expect(address, key).toBe(key === "solana" ? SOLANA : EVM);
    }
    // Solana is offered only once its wallet exists.
    expect(depositNetworks({ evm: EVM, solana: null }).map(({ key }) => key)).toEqual(
      NETWORK_KEYS.filter((key) => key !== "solana"),
    );
  });

  it("names every network a withdrawal goes to, Base first", () => {
    expect(WITHDRAW_NETWORKS[0]).toEqual({ id: "base", name: "Base" });
    for (const { id, name } of WITHDRAW_NETWORKS) {
      expect(name).toBe(NETWORKS[id].name);
      expect(NETWORKS[id].viem?.testnet ?? false, id).toBe(false);
    }
  });
});
