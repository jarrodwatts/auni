import { ETHEREUM } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { coinName, coinOf, isPlainCash } from "./coins.ts";
import { evmTokenKey, solanaMintKey } from "./fill-key.ts";

describe("coinOf", () => {
  it("knows a wrapped coin by its address in any case, and nothing else", () => {
    expect(coinOf(evmTokenKey("monad", "0xee8c0e9f1bffb4eb878d8f15f368a02a35481242"))?.name).toBe(
      "Ethereum",
    );
    expect(coinOf(evmTokenKey("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"))).toBeNull();
  });

  it("reads each chain's stand-in address as its own coin", () => {
    expect(coinOf(evmTokenKey("base", "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"))?.name).toBe(
      "Ethereum",
    );
    expect(coinOf(solanaMintKey("So11111111111111111111111111111111111111112"))?.name).toBe(
      "Solana",
    );
  });

  it("knows the own coin of an EVM chain outside the registry by the currency viem gives it", () => {
    expect(coinOf(evmTokenKey("eip155:10", "native"))).toBe(ETHEREUM);
    expect(coinOf(evmTokenKey("eip155:1", "native"))).toBe(ETHEREUM);
    // AVAX is no coin of Auni's networks, so it has no mark to wear.
    expect(coinOf(evmTokenKey("eip155:43114", "native"))).toBeNull();
  });
});

describe("coinName", () => {
  it("names each network's USDT by Tether's address, in any case, and Base, with none, nothing", () => {
    expect(coinName(evmTokenKey("arbitrum", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"))).toBe(
      "USDT",
    );
    expect(coinName(evmTokenKey("polygon", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F"))).toBe(
      "USDT",
    );
    expect(coinName(evmTokenKey("monad", "0xe7cd86e13AC4309349F30B3435a9d337750fC82D"))).toBe(
      "USDT",
    );
    expect(coinName(solanaMintKey("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"))).toBe("USDT");
    // Bridged from Ethereum by Base's own bridge, not issued by Tether.
    expect(coinName(evmTokenKey("base", "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2"))).toBeNull();
  });

  it("never names a token by the name it gives itself, nor one network's USDT on another", () => {
    expect(
      coinName(evmTokenKey("arbitrum", "0x8888888888888888888888888888888888888888")),
    ).toBeNull();
    // USDT0's Monad address is someone else's token on Base.
    expect(coinName(evmTokenKey("base", "0xe7cd86e13AC4309349F30B3435a9d337750fC82D"))).toBeNull();
    expect(
      coinName(evmTokenKey("eip155:1", "0xdAC17F958D2ee523a2206206994597C13D831ec7")),
    ).toBeNull();
  });

  it("still names the network's own coin and USDC", () => {
    expect(coinName(evmTokenKey("base", "native"))).toBe("ETH");
    expect(coinName(evmTokenKey("base", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"))).toBe(
      "USDC",
    );
  });
});

describe("isPlainCash", () => {
  it("counts USDC as cash and USDT as a token held", () => {
    expect(isPlainCash("arbitrum", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831")).toBe(true);
    expect(isPlainCash("arbitrum", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9")).toBe(false);
    expect(isPlainCash("solana", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")).toBe(false);
  });
});
