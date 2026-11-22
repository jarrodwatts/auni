import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Signer } from "./recipe.ts";
import { solFor, topUpSol } from "./sol-top-up.ts";
import { pinnedSol, RELAYED_SOL } from "../test/sol.ts";
import { openUsdcAccount, solToOpen } from "./usdc-account.ts";
import { SOLANA_USDC } from "./chains.ts";
import { paysOwnGas } from "./wallets.ts";

// What Solana says owns the account at each address: none until a test says.
const { owners } = vi.hoisted(() => ({ owners: new Map<string, string>() }));
vi.mock(import("./chains.ts"), async (original) => ({
  ...(await original()),
  solanaKitRpc: (() => ({
    getAccountInfo: (account: string) => ({
      send: async () => ({ value: owners.has(account) ? { owner: owners.get(account) } : null }),
    }),
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0n },
      }),
    }),
  })) as never,
}));

// A wallet with a sponsor unless a test says it pays its own way; what a top-up buys
// and how is checked in sol-top-up.test.ts.
vi.mock(import("./wallets.ts"), async (original) => ({
  ...(await original()),
  paysOwnGas: vi.fn(async () => false),
}));
vi.mock(import("./sol-top-up.ts"), async (original) => ({
  ...(await original()),
  solFor: vi.fn(async () => null),
  topUpSol: vi.fn(async () => [{ chain: "monad", hash: "0xrelay", setup: true as const }]),
}));

const WALLET = "So11111111111111111111111111111111111111112";
// Someone's wallet, and its USDC account.
const OWNER = "JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n";
const OWNER_USDC = "8qahG34kuEuP8RySeDxq9HPt2fJewu4cMj5FZZdqQA6r";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

const send = vi.fn(async (_tx: string, _options?: object) => "signature");
const wallets = { solanaAddress: WALLET, sendSolanaTransaction: send } as unknown as Signer;

beforeEach(() => {
  owners.clear();
  vi.clearAllMocks();
  vi.mocked(paysOwnGas).mockResolvedValue(false);
  vi.mocked(solFor).mockResolvedValue(null);
});

describe("a USDC account on Solana", () => {
  it("is opened when its address holds only SOL sent there, not a token account", async () => {
    owners.set(OWNER_USDC, "11111111111111111111111111111111");
    expect(await openUsdcAccount(wallets, OWNER)).toHaveLength(1);
  });

  it("opens nothing when it's open", async () => {
    owners.set(OWNER_USDC, SOLANA_USDC.tokenProgram);
    expect(await openUsdcAccount(wallets, OWNER)).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it("is opened for its owner from the owner's wallet, in setup its sponsor pays for, rent and all", async () => {
    expect(await openUsdcAccount(wallets, OWNER)).toEqual([
      { chain: "solana", hash: "signature", setup: true },
    ]);
    // The sponsor pays for whatever doesn't pay its own fee, and pays the rent of what it opens.
    expect(send).toHaveBeenCalledWith(expect.any(String), { setup: true });
    const [tx] = send.mock.calls[0] ?? [];
    const message = getCompiledTransactionMessageDecoder().decode(
      getTransactionDecoder().decode(getBase64Encoder().encode(tx ?? "")).messageBytes,
    );
    if (!("instructions" in message)) throw new Error("not a v0 message");
    const accounts = message.staticAccounts;
    expect(accounts[0]).toBe(WALLET);
    // One instruction: the associated token program's CreateIdempotent, which does nothing once
    // it's open, so a retry or a move racing it is harmless.
    expect(message.instructions).toHaveLength(1);
    const [open] = message.instructions;
    expect(accounts[open?.programAddressIndex ?? -1]).toBe(ATA_PROGRAM);
    expect([...(open?.data ?? [])]).toEqual([1]);
    expect(open?.accountIndices?.slice(0, 4).map((index) => accounts[index])).toEqual([
      WALLET,
      OWNER_USDC,
      OWNER,
      SOLANA_USDC.mint,
    ]);
  });

  const plan = RELAYED_SOL;

  it("costs a wallet with a sponsor no SOL to open, nor a look at what it holds", async () => {
    expect(await solToOpen(WALLET, OWNER)).toBeNull();
    expect(solFor).not.toHaveBeenCalled();
  });

  it("shows the SOL a wallet paying its own way buys to open it, once it isn't open", async () => {
    vi.mocked(paysOwnGas).mockResolvedValue(true);
    vi.mocked(solFor).mockResolvedValue(plan);
    expect(await solToOpen(WALLET, OWNER)).toBe(plan);
    expect(solFor).toHaveBeenCalledWith(expect.any(String), WALLET);
    owners.set(OWNER_USDC, SOLANA_USDC.tokenProgram);
    expect(await solToOpen(WALLET, OWNER)).toBeNull();
  });

  it("buys that SOL first, as its card showed, then opens it on a fresh build", async () => {
    vi.mocked(paysOwnGas).mockResolvedValue(true);
    vi.mocked(solFor).mockResolvedValue(plan);
    const card = { amountUsd: "20", details: pinnedSol("1000000") };
    expect(await openUsdcAccount(wallets, OWNER, card)).toEqual([
      { chain: "monad", hash: "0xrelay", setup: true },
      { chain: "solana", hash: "signature", setup: true },
    ]);
    expect(solFor).toHaveBeenCalledWith(expect.any(String), WALLET, { approved: card });
    expect(topUpSol).toHaveBeenCalledWith(wallets, plan);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
