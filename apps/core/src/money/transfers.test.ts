import { NETWORKS } from "@auni/shared";
import { HttpRequestError, MethodNotFoundRpcError } from "viem";
import { describe, expect, it, vi } from "vitest";

import { publicClient, solanaRpc } from "./chains.ts";
import {
  evmMoves,
  readTransfers,
  solanaTransfers,
  type CallFrame,
  type SolanaTransaction,
} from "./transfers.ts";

vi.mock("./chains.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  solanaRpc: vi.fn(),
}));
const { XSTOCK } = vi.hoisted(() => ({ XSTOCK: "0x1aad217b8f78dba5e6693460e8470f8b1a3977f3" }));
vi.mock("./swaps/xstocks.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  evmXStocks: async () => new Set([XSTOCK]),
}));

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const topic = (address: string) => `0x${address.slice(2).padStart(64, "0")}` as const;
const amount = (units: bigint) => `0x${units.toString(16).padStart(64, "0")}` as const;

describe("evmMoves", () => {
  it("finds tokens by their Transfer logs and coin at any depth of the trace, nothing that reverted", () => {
    const logs = [
      // In, and out.
      {
        address: TOKEN,
        topics: [TRANSFER, topic(OTHER), topic(WALLET)],
        data: amount(5n),
        logIndex: 44,
      },
      {
        address: TOKEN,
        topics: [TRANSFER, topic(WALLET), topic(OTHER)],
        data: amount(2n),
        logIndex: 45,
      },
      // An NFT indexes its id as a third topic, and a zero transfer is the usual poisoning.
      {
        address: TOKEN,
        topics: [TRANSFER, topic(OTHER), topic(WALLET), amount(1n)],
        data: "0x",
        logIndex: 46,
      },
      {
        address: TOKEN,
        topics: [TRANSFER, topic(OTHER), topic(WALLET)],
        data: amount(0n),
        logIndex: 47,
      },
    ] as never;
    const trace: CallFrame = {
      type: "CALL",
      from: OTHER,
      to: TOKEN,
      value: "0x0",
      calls: [
        { type: "CALL", from: TOKEN, to: WALLET, value: "0x64" },
        // A delegate call repeats its caller's value, and a reverted call moved nothing under it.
        { type: "DELEGATECALL", from: TOKEN, to: WALLET, value: "0x64" },
        {
          type: "CALL",
          from: TOKEN,
          to: OTHER,
          value: "0x0",
          error: "execution reverted",
          calls: [{ type: "CALL", from: OTHER, to: WALLET, value: "0x1" }],
        },
      ],
    };
    expect(evmMoves("base", logs, trace, WALLET.toUpperCase().replace("0X", "0x"))).toEqual([
      { position: "log:0", token: TOKEN, instrument: TOKEN, baseUnits: 5n, counterparty: OTHER },
      { position: "log:1", token: TOKEN, instrument: TOKEN, baseUnits: -2n, counterparty: OTHER },
      {
        position: "call:1",
        token: null,
        instrument: "native",
        baseUnits: 100n,
        counterparty: TOKEN,
      },
    ]);
  });

  it("places a log within its transaction, so one reorged into another block is the same transfer", () => {
    const deposit = (logIndex: number) =>
      [
        {
          address: TOKEN,
          topics: [TRANSFER, topic(OTHER), topic(WALLET)],
          data: amount(5n),
          logIndex,
        },
      ] as never;
    const trace: CallFrame = { type: "CALL", from: OTHER, to: TOKEN, value: "0x0" };
    const [first] = evmMoves("polygon", deposit(12), trace, WALLET);
    const [again] = evmMoves("polygon", deposit(87), trace, WALLET);
    expect(again?.position).toBe(first?.position);
  });

  it("leaves Polygon's POL logs to the trace, which already shows them", () => {
    const pol = "0x0000000000000000000000000000000000001010";
    const logs = [
      {
        address: pol,
        topics: [TRANSFER, topic(OTHER), topic(WALLET)],
        data: amount(7n),
        logIndex: 1,
      },
    ] as never;
    const trace: CallFrame = { type: "CALL", from: OTHER, to: WALLET, value: "0x7" };
    expect(evmMoves("polygon", logs, trace, WALLET).map((move) => move.position)).toEqual([
      "call:0",
    ]);
  });
});

describe("solanaTransfers", () => {
  const SOL_WALLET = "Wa11et1111111111111111111111111111111111111";
  const SENDER = "Sender11111111111111111111111111111111111111";
  const usdc = (accountIndex: number, owner: string, units: number) => ({
    accountIndex,
    mint: NETWORKS.solana.usdc,
    owner,
    uiTokenAmount: { amount: String(units), decimals: 6 },
  });
  const tx = (meta: Partial<NonNullable<SolanaTransaction["meta"]>>): SolanaTransaction => ({
    slot: 1,
    blockTime: 1,
    meta: { err: null, fee: 5_000, preBalances: [], postBalances: [], ...meta },
    transaction: {
      message: {
        accountKeys: [SENDER, SOL_WALLET, "Token11", "Token22"].map((pubkey) => ({ pubkey })),
      },
    },
  });

  it("reads a token arriving at the wallet's token account, by its owner, and SOL less the fee it didn't move", () => {
    const transfers = solanaTransfers(
      tx({
        preBalances: [1_000_000, 0, 0, 0],
        postBalances: [495_000, 500_000, 0, 0],
        preTokenBalances: [usdc(2, SENDER, 9_000_000)],
        postTokenBalances: [usdc(2, SENDER, 4_000_000), usdc(3, SOL_WALLET, 5_000_000)],
      }),
      SOL_WALLET,
    );
    expect(transfers).toEqual([
      {
        position: NETWORKS.solana.usdc,
        instrument: NETWORKS.solana.usdc,
        decimals: 6,
        baseUnits: 5_000_000n,
        counterparty: SENDER,
      },
      {
        position: "native",
        instrument: "native",
        decimals: 9,
        baseUnits: 500_000n,
        counterparty: SENDER,
      },
    ]);
  });

  it("reads nothing from a transaction that failed", () => {
    expect(solanaTransfers(tx({ err: { InstructionError: [0, "Custom"] } }), SOL_WALLET)).toEqual(
      [],
    );
  });
});

describe("readTransfers", () => {
  const base = publicClient("base");
  /** Base shows `logs` from a successful transaction `from` sent, its trace moving no coin. */
  function evmTransaction(from: string, logs: unknown[] = []) {
    vi.spyOn(base, "getTransactionReceipt").mockResolvedValue({
      status: "success",
      blockNumber: 7n,
      from,
      logs,
    } as never);
    vi.spyOn(base, "getBlock").mockResolvedValue({ timestamp: 1_700_000_000n } as never);
    vi.spyOn(base, "request").mockResolvedValue({ type: "CALL", from, to: TOKEN } as never);
    vi.spyOn(base, "multicall").mockResolvedValue([{ status: "success", result: 6 }] as never);
  }

  it("knows an EVM transaction the wallet sent itself", async () => {
    evmTransaction(WALLET.toUpperCase().replace("0X", "0x"));
    expect((await readTransfers("base", "0xabc", WALLET)).walletSigned).toBe(true);
    evmTransaction(OTHER);
    expect((await readTransfers("base", "0xabc", WALLET)).walletSigned).toBe(false);
  });

  it("counts an xStock that moved by its shares at the transaction's block, as DefiLlama prices one", async () => {
    const sent = (token: string, units: bigint) => ({
      address: token,
      topics: [TRANSFER, topic(OTHER), topic(WALLET)],
      data: amount(units),
    });
    evmTransaction(OTHER, [sent(XSTOCK, 2_194n * 10n ** 15n), sent(TOKEN, 5n)]);
    // Each token's decimals, then its symbol.
    vi.spyOn(base, "multicall").mockResolvedValue([
      { status: "success", result: 18 },
      { status: "success", result: "STRCx" },
      { status: "success", result: 6 },
      { status: "success", result: "TKN" },
    ] as never);
    // STRCx's multiplier on Monad in October 2026: its balance is 1.097 times its shares.
    const multiplier = vi.spyOn(base, "readContract").mockResolvedValue(1_097n * 10n ** 15n);

    expect((await readTransfers("base", "0xabc", WALLET)).transfers).toEqual([
      expect.objectContaining({
        instrument: XSTOCK,
        baseUnits: 2_194n * 10n ** 15n,
        pricedUnits: 2n * 10n ** 18n,
        symbol: "STRCx",
      }),
      expect.not.objectContaining({ pricedUnits: expect.anything() }),
    ]);
    expect(multiplier).toHaveBeenCalledOnce();
    expect(multiplier).toHaveBeenCalledWith(
      expect.objectContaining({ address: XSTOCK, functionName: "multiplier", blockNumber: 7n }),
    );
  });

  it("reads coin from the transaction's own call where the RPC serves no traces", async () => {
    evmTransaction(OTHER, [
      { address: TOKEN, topics: [TRANSFER, topic(OTHER), topic(WALLET)], data: amount(5n) },
    ]);
    vi.spyOn(base, "request").mockRejectedValue(
      new MethodNotFoundRpcError(new Error("debug_traceTransaction does not exist")),
    );
    vi.spyOn(base, "getTransaction").mockResolvedValue({
      from: OTHER,
      to: WALLET,
      value: 3n,
    } as never);
    expect((await readTransfers("base", "0xabc", WALLET)).transfers).toEqual([
      expect.objectContaining({ position: "log:0", instrument: TOKEN, baseUnits: 5n }),
      expect.objectContaining({ position: "call:0", instrument: "native", baseUnits: 3n }),
    ]);
    // An RPC that gave no answer is asked again later, not read around.
    vi.spyOn(base, "request").mockRejectedValue(new HttpRequestError({ url: "https://rpc" }));
    await expect(readTransfers("base", "0xabc", WALLET)).rejects.toThrow(HttpRequestError);
  });

  it("knows a Solana transaction the wallet signed, whoever paid its fee", async () => {
    const SOL_WALLET = "Wa11et1111111111111111111111111111111111111";
    const signed = (signer: boolean) =>
      vi.mocked(solanaRpc).mockResolvedValue({
        slot: 1,
        blockTime: 1,
        meta: { err: null, fee: 5_000, preBalances: [0, 0], postBalances: [0, 0] },
        transaction: {
          message: {
            accountKeys: [
              { pubkey: "FeePayer1111111111111111111111111111111111", signer: true },
              { pubkey: SOL_WALLET, signer },
            ],
          },
        },
      } satisfies SolanaTransaction);
    signed(true);
    expect((await readTransfers("solana", "sig", SOL_WALLET)).walletSigned).toBe(true);
    // Named in someone else's transaction, as anyone can: theirs, not the wallet's.
    signed(false);
    expect((await readTransfers("solana", "sig", SOL_WALLET)).walletSigned).toBe(false);
  });

  it("knows the wallet's Solana token accounts a transaction closed or handed to another owner", async () => {
    const SOL_WALLET = "Wa11et1111111111111111111111111111111111111";
    const OTHER_OWNER = "Other11111111111111111111111111111111111111";
    const held = (accountIndex: number, owner: string, mint: string = NETWORKS.solana.usdc) => ({
      accountIndex,
      mint,
      owner,
      uiTokenAmount: { amount: "0", decimals: 6 },
    });
    vi.mocked(solanaRpc).mockResolvedValue({
      slot: 1,
      blockTime: 1,
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [0, 0, 0, 0, 0],
        postBalances: [0, 0, 0, 0, 0],
        preTokenBalances: [
          held(1, SOL_WALLET, "Mint1"),
          held(2, SOL_WALLET),
          held(3, SOL_WALLET),
          held(4, OTHER_OWNER),
        ],
        // Closed1 is gone, Kept1 is still the wallet's, Given1 another's; Theirs1 never was.
        postTokenBalances: [held(2, SOL_WALLET), held(3, OTHER_OWNER), held(4, OTHER_OWNER)],
      },
      transaction: {
        message: {
          accountKeys: [SOL_WALLET, "Closed1", "Kept1", "Given1", "Theirs1"].map((pubkey) => ({
            pubkey,
          })),
        },
      },
    } satisfies SolanaTransaction);
    expect((await readTransfers("solana", "sig", SOL_WALLET)).closedAccounts).toEqual([
      { address: "Closed1", mint: "Mint1" },
      { address: "Given1", mint: NETWORKS.solana.usdc },
    ]);
  });
});
