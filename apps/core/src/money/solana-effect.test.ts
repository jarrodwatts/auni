import { NETWORKS } from "@auni/shared";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  decompileTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { describe, expect, it, vi } from "vitest";

import { solanaRpc } from "./chains.ts";
import { WRAPPED_SOL } from "./fill-key.ts";
import { effectOf, simulateSolana, type Balances, type TokenBalance } from "./solana-effect.ts";

vi.mock(import("./chains.ts"), async (original) => ({
  ...(await original()),
  solanaRpc: vi.fn(),
}));

const OWNER = "JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n";
const POOL = "GZuFT72jZWfuZk4YC6diVDWJ4LZGQNQnrUNLbsYjFo5i";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const RENT = 1_488_440;

/** The wallet, its USDC account, its BONK account, and an account of someone else's. */
const keys = [OWNER, "usdc-account", "bonk-account", "pool-account"];
const balance = (accountIndex: number, mint: string, amount: number, owner = OWNER) =>
  ({
    accountIndex,
    mint,
    owner,
    uiTokenAmount: { amount: String(amount), decimals: 6 },
  }) satisfies TokenBalance;

function balances(
  lamports: readonly (readonly [number, number])[],
  tokens: { pre: TokenBalance[]; post: TokenBalance[] },
  fee = 5_000,
): Balances {
  return {
    accountKeys: keys,
    fee,
    preBalances: lamports.map(([pre]) => pre),
    postBalances: lamports.map(([, post]) => post),
    preTokenBalances: tokens.pre,
    postTokenBalances: tokens.post,
  };
}

describe("effectOf", () => {
  it("reads a buy that opens the wallet's own token account as a trade, its rent kept apart", () => {
    const sol = 10_000_000;
    const effect = effectOf(
      balances(
        [
          [sol, sol - 5_000 - RENT],
          [RENT, RENT],
          [0, RENT],
          [RENT, RENT],
        ],
        {
          pre: [balance(1, NETWORKS.solana.usdc, 5_000_000), balance(3, BONK, 900, POOL)],
          post: [
            balance(1, NETWORKS.solana.usdc, 0),
            balance(2, BONK, 100),
            balance(3, BONK, 800, POOL),
          ],
        },
      ),
      OWNER,
    );
    expect(effect).toEqual({
      out: [{ token: NETWORKS.solana.usdc, amount: 5_000_000n }],
      in: [{ token: BONK, amount: 100n }],
      rent: BigInt(RENT),
    });
  });

  it("nets wrapping SOL into the SOL it sells, and leaves out the fee", () => {
    // 1 SOL wrapped into a fresh account, swapped for USDC, and the account closed again.
    const effect = effectOf(
      balances(
        [
          [2_000_000_000, 1_000_000_000 - 5_000],
          [RENT, RENT],
        ],
        {
          pre: [balance(1, NETWORKS.solana.usdc, 0)],
          post: [balance(1, NETWORKS.solana.usdc, 150_000_000)],
        },
      ),
      OWNER,
    );
    expect(effect.out).toEqual([{ token: WRAPPED_SOL, amount: 1_000_000_000n }]);
    expect(effect.in).toEqual([{ token: NETWORKS.solana.usdc, amount: 150_000_000n }]);
    expect(effect.rent).toBe(0n);
  });

  it("counts wrapped SOL left in the wallet's own account as still held", () => {
    const wsol = {
      ...balance(2, WRAPPED_SOL, 1_000_000_000),
      uiTokenAmount: { amount: "1000000000", decimals: 9 },
    };
    const effect = effectOf(
      balances(
        [
          [2_000_000_000, 1_000_000_000 - 5_000 - RENT],
          [0, 0],
          [0, 1_000_000_000 + RENT],
        ],
        { pre: [], post: [wsol] },
      ),
      OWNER,
    );
    expect(effect).toEqual({ out: [], in: [], rent: BigInt(RENT) });
  });

  it("reads a token account handed to someone else as its tokens and rent sent", () => {
    const effect = effectOf(
      balances(
        [
          [10_000_000, 10_000_000 - 5_000],
          [RENT, RENT],
        ],
        {
          pre: [balance(1, NETWORKS.solana.usdc, 7_000_000)],
          post: [balance(1, NETWORKS.solana.usdc, 7_000_000, POOL)],
        },
      ),
      OWNER,
    );
    expect(effect.out).toEqual([
      { token: WRAPPED_SOL, amount: BigInt(RENT) },
      { token: NETWORKS.solana.usdc, amount: 7_000_000n },
    ]);
    expect(effect.in).toEqual([]);
  });

  it("charges no fee to a wallet that didn't pay it, as on a sponsored transaction", () => {
    const sponsored = balances(
      [
        [50_000_000, 50_000_000 - 5_000],
        [RENT, RENT],
        [0, 0],
      ],
      {
        pre: [balance(1, NETWORKS.solana.usdc, 1_000_000)],
        post: [balance(1, NETWORKS.solana.usdc, 0)],
      },
    );
    const effect = effectOf({ ...sponsored, accountKeys: [POOL, "usdc-account", OWNER] }, OWNER);
    expect(effect.out).toEqual([{ token: NETWORKS.solana.usdc, amount: 1_000_000n }]);
    expect(effect.in).toEqual([]);
  });
});

describe("simulateSolana", () => {
  const owner = address(OWNER);
  const SWAP_PROGRAM = address("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
  const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  /** A route's swap as it builds one: open the account what it gets lands in, then swap. */
  const swap = getBase64EncodedWireTransaction(
    compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (draft) => setTransactionMessageFeePayer(owner, draft),
        (draft) =>
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: "11111111111111111111111111111111" as Blockhash,
              lastValidBlockHeight: 0n,
            },
            draft,
          ),
        (draft) =>
          appendTransactionMessageInstructions(
            [
              getCreateAssociatedTokenIdempotentInstruction({
                payer: createNoopSigner(owner),
                ata: address(POOL),
                owner,
                mint: address(BONK),
                tokenProgram: TOKEN_PROGRAM,
              }),
              { programAddress: SWAP_PROGRAM, accounts: [], data: new Uint8Array([1]) },
            ],
            draft,
          ),
      ),
    ),
  );
  /** The programs of the transaction Solana was asked to simulate. */
  const programsSimulated = () => {
    const [, [wire]] = vi
      .mocked(solanaRpc)
      .mock.calls.find(([method]) => method === "simulateTransaction") as [string, [string]];
    const { messageBytes } = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
    const message = decompileTransactionMessage(
      getCompiledTransactionMessageDecoder().decode(messageBytes),
    );
    const instructions: readonly { readonly programAddress: string }[] = message.instructions;
    return instructions.map(({ programAddress }) => programAddress);
  };

  // A swap whose cash an earlier move on the same card brings can't run from the wallet yet, so
  // what it opens and pays is read from the rest (see solForSwap).
  it("runs only the instructions to Solana's own programs, setup only", async () => {
    vi.mocked(solanaRpc).mockImplementation((async (method: string) =>
      method === "getMultipleAccounts"
        ? { value: [null, null] }
        : {
            value: {
              ...balances([[10_000_000, 10_000_000 - 5_000 - RENT]], { pre: [], post: [] }),
              err: null,
              logs: [],
              innerInstructions: [],
              loadedAddresses: null,
              accounts: [
                { owner: "11111111111111111111111111111111", space: 0, data: ["", "base64"] },
              ],
            },
          }) as never);
    await simulateSolana(swap, owner, { paysOwnFee: true, setupOnly: true });
    expect(programsSimulated()).toEqual(["ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"]);
    vi.mocked(solanaRpc).mockClear();
    await simulateSolana(swap, owner, { paysOwnFee: true });
    expect(programsSimulated()).toEqual([
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      SWAP_PROGRAM,
    ]);
  });
});
