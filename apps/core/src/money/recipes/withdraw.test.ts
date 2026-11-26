import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRow } from "../../db/schema.ts";
import { feeCoinsSaid } from "../fee-coin-said.ts";
import { solFor, topUpSol, type SolTopUp } from "../sol-top-up.ts";
import { pinnedSol, RELAYED_SOL } from "../../test/sol.ts";
import type { Signer } from "../recipe.ts";
import { withdrawUsdc } from "./withdraw.ts";

// A wallet with USDC on Solana and no SOL, withdrawing there; what buying its SOL takes is
// checked in sol-top-up.test.ts.
const WALLET = "So11111111111111111111111111111111111111112";
const TO = "JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n";
const BLOCKHASHES = [
  "11111111111111111111111111111111",
  "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi",
];

const chain = vi.hoisted(() => ({ blockhashes: 0 }));
vi.mock("../chains.ts", async (original) => ({
  ...(await original()),
  solanaKitRpc: (() => ({
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash: BLOCKHASHES[chain.blockhashes++ % 2], lastValidBlockHeight: 0n },
      }),
    }),
  })) as never,
}));
vi.mock("../wallets.ts", async (original) => ({
  ...(await original()),
  walletAddresses: async () => ({ evm: null, solana: WALLET }),
}));
vi.mock("../withdrawals.ts", async (original) => ({
  ...(await original()),
  refuseTokenDestination: async () => {},
  walletUsdc: async () => new Map([["solana", 50_000_000n]]),
}));
vi.mock("../sol-top-up.ts", async (original) => ({
  ...(await original()),
  solFor: vi.fn(async (): Promise<SolTopUp | null> => null),
  topUpSol: vi.fn(async () => [{ chain: "monad", hash: "0xrelay", setup: true as const }]),
}));

const input = {
  amount_usd: "20",
  network: "solana",
  address: TO,
  destination: "wallet",
} as const;
const relay = RELAYED_SOL;

const send = vi.fn(async (_tx: string) => "signature");
const wallets = { solanaAddress: WALLET, sendSolanaTransaction: send } as unknown as Signer;

/** The blockhash a sent transaction was built on. */
function blockhashOf(tx: string): string {
  const { messageBytes } = getTransactionDecoder().decode(getBase64Encoder().encode(tx));
  return getCompiledTransactionMessageDecoder().decode(messageBytes).lifetimeToken;
}

beforeEach(() => {
  vi.clearAllMocks();
  chain.blockhashes = 0;
  vi.mocked(solFor).mockResolvedValue(null);
});

describe("where a withdrawal goes, as its card says", () => {
  it("names the address unless the owner said whose it is", async () => {
    // The live test of 2026-11-13 sent 50 cents to an address the owner never said was theirs,
    // and the card, its confirm step and its receipt all said "to your wallet".
    const named = await withdrawUsdc.describe({ ...input, destination: undefined }, {});
    expect(named.summary).toBe("Withdraw $20 to JAVqaE…6X8n on Solana");
    expect(named.card?.receipt?.title).toBe("Withdrew $20 to JAVqaE…6X8n on Solana");
    expect((await withdrawUsdc.describe(input, {})).summary).toBe(
      "Withdraw $20 to your other wallet on Solana",
    );
    expect((await withdrawUsdc.describe({ ...input, destination: "exchange" }, {})).summary).toBe(
      "Withdraw $20 to your exchange on Solana",
    );
  });
});

describe("withdrawing USDC on Solana", () => {
  it("shows the SOL a wallet that pays its own way buys for the transfer, beside it and as no cost", async () => {
    vi.mocked(solFor).mockResolvedValue(relay);
    const preview = await withdrawUsdc.describe(input, {});
    expect(solFor).toHaveBeenCalledWith(expect.any(String), WALLET, { spends: 20_000_000n });
    // Its face says nothing of the purchase itself: every card says that the one way (below).
    expect(preview.card?.finePrint).toBeNull();
    expect(feeCoinsSaid([{ details: preview.details! }])).toBe(
      "Also buys about $1 of SOL for network fees, most of which stays in your wallet. Bought through Relay.",
    );
    // As the coin an EVM chain's fees are paid in is said, never a cost: most of it stays.
    expect(preview.effect.costs ?? []).toEqual([]);
    // What execute spends on it, and what the confirm step says of it.
    expect(preview.details).toMatchObject({
      from: "solana",
      ...pinnedSol("1000000"),
      arrives: "In seconds",
      solForFees: "$1",
    });
    expect(preview.details).not.toHaveProperty("fee");
  });

  it("shows none when the wallet holds enough SOL, or its sponsor pays", async () => {
    const preview = await withdrawUsdc.describe(input, {});
    expect(preview.card?.finePrint).toBeNull();
    expect(preview.details).not.toHaveProperty("solForFees");
    expect(preview.effect).not.toHaveProperty("costs");
    expect(feeCoinsSaid([{ details: preview.details! }])).toBeNull();
  });

  it("buys that SOL first, as its card showed, then sends the transfer built afresh", async () => {
    vi.mocked(solFor).mockResolvedValue(relay);
    const action = {
      amountUsd: "20.00",
      details: { leavesTo: TO, from: "solana", ...pinnedSol("1000000") },
    } as unknown as ActionRow;
    const result = await withdrawUsdc.execute({
      action,
      input,
      wallets,
      recordSent: async () => {},
      posting: (_chain, post) => post(),
    });
    expect(solFor).toHaveBeenCalledWith(expect.any(String), WALLET, {
      spends: 20_000_000n,
      approved: action,
    });
    expect(topUpSol).toHaveBeenCalledWith(wallets, relay);
    // On a blockhash taken after the top-up's wait, which the first one might not outlive.
    expect(send).toHaveBeenCalledTimes(1);
    expect(blockhashOf(send.mock.calls[0]![0])).toBe(BLOCKHASHES[1]);
    expect(result).toEqual({
      txs: [
        { chain: "monad", hash: "0xrelay", setup: true },
        { chain: "solana", hash: "signature" },
      ],
      fills: [],
    });
  });

  it("sends the transfer as it was checked when the wallet needs no SOL", async () => {
    const action = {
      amountUsd: "20.00",
      details: { leavesTo: TO, from: "solana" },
    } as unknown as ActionRow;
    const result = await withdrawUsdc.execute({
      action,
      input,
      wallets,
      recordSent: async () => {},
      posting: (_chain, post) => post(),
    });
    expect(topUpSol).not.toHaveBeenCalled();
    expect(result.txs).toEqual([{ chain: "solana", hash: "signature" }]);
  });
});

describe("a withdrawal's destination, checked again as it runs", () => {
  // However the stored card came to name it, a destination its preview would refuse never gets paid.
  it.each([
    ["the wallet's own Solana address", "solana", WALLET],
    ["Solana's USDC mint", "solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"],
    ["Base's USDC contract", "base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
    ["the burn address", "base", "0x0000000000000000000000000000000000000000"],
  ] as const)("refuses %s, sending nothing", async (_, network, to) => {
    const sendEvm = vi.fn(async () => "0xhash");
    const action = {
      amountUsd: "20.00",
      details: { leavesTo: to, from: network },
    } as unknown as ActionRow;
    await expect(
      withdrawUsdc.execute({
        action,
        input: { ...input, network, address: to },
        wallets: { ...wallets, evmAddress: "", sendEvmTransaction: sendEvm } as Signer,
        recordSent: async () => {},
        posting: (_chain, post) => post(),
      }),
    ).rejects.toThrow(/not a wallet|your Auni wallet|burn address/u);
    expect(send).not.toHaveBeenCalled();
    expect(sendEvm).not.toHaveBeenCalled();
  });
});
