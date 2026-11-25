import { NETWORKS } from "@auni/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { publicClient } from "./chains.ts";
import {
  destinationAddress,
  lookalikeOf,
  maxWithdrawal,
  recentPlaces,
  refuseTokenDestination,
  withdrawalSource,
} from "./withdrawals.ts";

const own = {
  evm: "0x5B7a3f0E2C9d41A8b6e0F7C2d9A4B1E3f6c8D0a2",
  solana: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
};
// Vitalik's public address, checksummed.
const EXCHANGE = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const SOLANA_WALLET = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("destinationAddress", () => {
  it("checksums an all-lowercase EVM address", () => {
    expect(destinationAddress("base", ` ${EXCHANGE.toLowerCase()} `, own)).toBe(EXCHANGE);
  });

  it("refuses mixed case that fails its checksum, the sign of a typo", () => {
    const typo = EXCHANGE.replace("6BF2", "6bF2");
    expect(() => destinationAddress("base", typo, own)).toThrow(/typo/u);
  });

  it("refuses USDC's own contract on any network, and the zero address", () => {
    expect(() => destinationAddress("arbitrum", NETWORKS.base.usdc, own)).toThrow(/token/u);
    expect(() => destinationAddress("base", `0x${"0".repeat(40)}`, own)).toThrow(/burn address/u);
  });

  // Live, 2026-11-14: "send all my USDC on Monad to 0x000...dEaD" made an ordinary card.
  it("refuses a burn address, however it is spelled, on every network", () => {
    for (const burn of [
      "0x000000000000000000000000000000000000dEaD",
      "0x000000000000000000000000000000000000dead",
      "0xdead000000000000000042069420694206942069",
      "0x0000000000000000000000000000000000000001",
    ])
      expect(() => destinationAddress("monad", burn, own)).toThrow(/gone for good/u);
    expect(() =>
      destinationAddress("solana", "1nc1nerator11111111111111111111111111111111", own),
    ).toThrow(/gone for good/u);
  });

  it("refuses the owner's own Auni wallet, in any case", () => {
    expect(() => destinationAddress("monad", own.evm.toLowerCase(), own)).toThrow(/Auni wallet/u);
    expect(() => destinationAddress("solana", own.solana, own)).toThrow(/Auni wallet/u);
  });

  it("keeps networks apart: an EVM address is no Solana address, and back", () => {
    expect(() => destinationAddress("solana", EXCHANGE, own)).toThrow(/Solana/u);
    expect(() => destinationAddress("base", SOLANA_WALLET, own)).toThrow(/0x/u);
  });

  it("takes a Solana key as is, and refuses the USDC mint", () => {
    expect(destinationAddress("solana", SOLANA_WALLET, own)).toBe(SOLANA_WALLET);
    expect(() => destinationAddress("solana", NETWORKS.solana.usdc, own)).toThrow(/token/u);
    expect(() => destinationAddress("solana", `${SOLANA_WALLET}1`, own)).toThrow(/Solana/u);
  });
});

describe("lookalikeOf", () => {
  const known = "0xAbCd1234567890aBcDeF1234567890AbCdEf9F8e";

  it("flags a different address with the same start and end", () => {
    const poison = "0xabcd999999999999999999999999999999999f8e";
    expect(lookalikeOf(poison, [known])).toBe(known);
  });

  it("never flags the known address itself, whatever its case", () => {
    expect(lookalikeOf(known.toLowerCase(), [known])).toBeNull();
  });

  it("leaves addresses that differ where people look alone", () => {
    expect(lookalikeOf("0xabce999999999999999999999999999999999f8e", [known])).toBeNull();
    expect(lookalikeOf("0xabcd999999999999999999999999999999999f8f", [known])).toBeNull();
  });

  it("compares Solana addresses case-sensitively", () => {
    const poison = `9WzD${"1".repeat(36)}AWWM`;
    expect(lookalikeOf(poison, [SOLANA_WALLET])).toBe(SOLANA_WALLET);
    expect(lookalikeOf(`9wzD${"1".repeat(36)}AWWM`, [SOLANA_WALLET])).toBeNull();
  });
});

describe("withdrawalSource", () => {
  const balances = new Map([
    ["monad", 200_000_000n],
    ["base", 50_000_000n],
    ["polygon", 120_000_000n],
    ["solana", 300_000_000n],
  ] as const);

  it("sends from the destination's own network when it holds enough", () => {
    expect(withdrawalSource("base", 50_000_000n, balances)).toBe("base");
    expect(withdrawalSource("solana", 250_000_000n, balances)).toBe("solana");
  });

  it("otherwise bridges from the EVM wallet holding the most", () => {
    expect(withdrawalSource("base", 60_000_000n, balances)).toBe("monad");
    expect(withdrawalSource("arbitrum", 100_000_000n, balances)).toBe("monad");
  });

  it("never bridges Solana cash to another network", () => {
    expect(withdrawalSource("base", 250_000_000n, balances)).toBeNull();
    expect(maxWithdrawal("base", balances)).toBe(200_000_000n);
    expect(maxWithdrawal("solana", balances)).toBe(300_000_000n);
  });

  it("refuses rather than split one withdrawal across wallets", () => {
    expect(withdrawalSource("polygon", 201_000_000n, balances)).toBeNull();
  });
});

describe("refuseTokenDestination", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Base answers for `address` with this code, and as a token with decimals or not. */
  const onBase = (code: string, decimals: number | null) => {
    vi.spyOn(publicClient("base"), "getCode").mockResolvedValue(code as `0x${string}`);
    vi.spyOn(publicClient("base"), "readContract").mockImplementation(async () => {
      if (decimals === null) throw new Error("execution reverted");
      return decimals;
    });
  };
  const someone = "0x2222222222222222222222222222222222222222";

  it("refuses a contract on chain that answers as a token, whose USDC would be lost", async () => {
    onBase("0x6080", 18);
    await expect(refuseTokenDestination("base", someone)).rejects.toThrow("token's own address");
  });

  it("lets a plain wallet, and a smart wallet that isn't a token, be paid", async () => {
    onBase("0x", null);
    await expect(refuseTokenDestination("base", someone)).resolves.toBeUndefined();
    onBase("0x6080", null);
    await expect(refuseTokenDestination("base", someone)).resolves.toBeUndefined();
  });

  it("refuses a Solana program or token account, and lets a wallet the System Program owns", async () => {
    const owned = (owner: string, executable: boolean) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json({ jsonrpc: "2.0", id: 1, result: { value: { owner, executable } } }),
        ),
      );
    const to = "JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n";
    owned("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", false);
    await expect(refuseTokenDestination("solana", to)).rejects.toThrow("token's own address");
    owned("BPFLoaderUpgradeab1e11111111111111111111111", true);
    await expect(refuseTokenDestination("solana", to)).rejects.toThrow("token's own address");
    owned("11111111111111111111111111111111", false);
    await expect(refuseTokenDestination("solana", to)).resolves.toBeUndefined();
  });

  it("refuses a destination it couldn't check, rather than paying it unchecked", async () => {
    vi.spyOn(publicClient("base"), "getCode").mockRejectedValue(new Error("rpc down"));
    await expect(refuseTokenDestination("base", someone)).rejects.toThrow("couldn't be checked");
  });
});

describe("recentPlaces", () => {
  const at = (day: number) => new Date(Date.UTC(2026, 10, day));
  const sent = (
    network: string,
    leavesTo: string | undefined,
    day: number,
    destination?: string,
  ) => ({
    input: { amount_usd: "10", network, address: leavesTo ?? "", destination },
    details: (leavesTo ? { leavesTo } : {}) as Record<string, string>,
    at: at(day),
  });

  it("lists each place once, newest first, with what the owner called it", () => {
    expect(
      recentPlaces([
        sent("base", EXCHANGE, 9, "exchange"),
        sent("solana", SOLANA_WALLET, 8, "wallet"),
        sent("base", EXCHANGE, 7, "exchange"),
        sent("arbitrum", EXCHANGE, 6),
      ]),
    ).toEqual([
      { address: EXCHANGE, network: "base", destination: "exchange", at: at(9) },
      { address: SOLANA_WALLET, network: "solana", destination: "wallet", at: at(8) },
      { address: EXCHANGE, network: "arbitrum", destination: null, at: at(6) },
    ]);
  });

  it("leaves out a record that doesn't say where it went, and stops at four", () => {
    const many = ["0x1", "0x2", "0x3", "0x4", "0x5"].map((to, day) => sent("base", to, 20 - day));
    expect(
      recentPlaces([sent("base", undefined, 21), sent("ethereum", "0x9", 21), ...many]).map(
        ({ address }) => address,
      ),
    ).toEqual(["0x1", "0x2", "0x3", "0x4"]);
  });
});
