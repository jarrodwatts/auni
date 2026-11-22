import { NETWORKS } from "@auni/shared";
import { readFileSync } from "node:fs";

import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  erc20Abi,
  pad,
  parseAbi,
  toEventSelector,
  type Hex,
} from "viem";
import { describe, expect, it, vi } from "vitest";

import { approval, effectLines } from "../../money/effect.ts";
import { MayHaveSent, type EvmTx, type Signer } from "../../money/recipe.ts";
import { Refused } from "../../money/refused.ts";
import { AAVE, aaveSupply, aaveWithdraw } from "./aave.ts";

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

// The pool may take `allowed` of the wallet's USDC, none at first, and pays 4.18% a year.
let allowed = 0n;
/** The receipts the chain has, by hash, for a read back. */
const receipts = new Map<string, object>();
vi.mock("../../money/chains.ts", async (original) => ({
  ...(await original()),
  publicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "allowance" ? allowed : { currentLiquidityRate: 418n * 10n ** 23n },
  }),
  evmClient: () => ({
    getTransactionReceipt: async ({ hash }: { hash: string }) => receipts.get(hash),
  }),
}));

/** What one supply sends, as one batch. */
async function supplied(amount_usd: string): Promise<readonly EvmTx[]> {
  const sent: (readonly EvmTx[])[] = [];
  const wallets = {
    evmAddress: OWNER,
    sendEvmTransaction: async (_chainId: number, txs: readonly EvmTx[]) => {
      sent.push(txs);
      return "0xsupply";
    },
  } as unknown as Signer;
  const result = await aaveSupply.execute({
    action: {} as never,
    input: { chain: "base", amount_usd },
    wallets,
    recordSent: async () => {},
    posting: (_chain, post) => post(),
  });
  expect(sent).toHaveLength(1);
  expect(result.txs).toEqual([{ chain: "base", hash: "0xsupply" }]);
  return sent[0]!;
}

// Aave's supply(asset, amount, onBehalfOf, referralCode), as the pool is called.
const SUPPLY_250 = {
  to: AAVE.base.pool,
  data: encodeFunctionData({
    abi: parseAbi(["function supply(address,uint256,address,uint16)"]),
    functionName: "supply",
    args: [NETWORKS.base.usdc, 250_000_000n, OWNER, 0],
  }),
};

describe("aave_supply", () => {
  it("puts cash into savings in the wallet, on a tap or a specialist's own", async () => {
    const { effect } = await aaveSupply.describe({ chain: "base", amount_usd: "250" }, {});
    expect(effectLines(effect)).toEqual([
      { label: "You give", value: "$250 of USDC on Base" },
      { label: "You get", value: "$250 in Aave savings, earning 4.18% a year now" },
    ]);
    expect(approval(effect, [])).toEqual({ kind: "tap" });
  });

  it("approves exactly what it supplies in the same batch, so no approval outlives a failed supply", async () => {
    allowed = 0n;
    const [approve, supply] = await supplied("250");
    expect(approve).toMatchObject({ to: NETWORKS.base.usdc, setup: true });
    expect(
      decodeFunctionData({ abi: erc20Abi, data: approve!.data as `0x${string}` }).args,
    ).toEqual([AAVE.base.pool, 250_000_000n]);
    expect(supply).toEqual(SUPPLY_250);
  });

  it("supplies alone when the pool may already take that much", async () => {
    allowed = 250_000_000n;
    expect(await supplied("250")).toEqual([SUPPLY_250]);
  });
});

/**
 * A wallet whose node answers every estimate with a recorded refusal (fixtures/problems/), as
 * local-key's send meets it: viem's own estimateGas, before anything is signed.
 */
function refusedBy(fixture: string): Signer {
  const { answer } = JSON.parse(
    readFileSync(new URL(`fixtures/problems/${fixture}`, import.meta.url), "utf8"),
  ) as { answer: unknown };
  const node = createPublicClient({
    transport: custom({
      request: async () => {
        throw answer;
      },
    }),
  });
  return {
    evmAddress: OWNER,
    sendEvmTransaction: async (_chainId: number, sent: EvmTx | readonly EvmTx[]) => {
      const last = [sent].flat().at(-1)!;
      await node.estimateGas({ account: OWNER, to: last.to as `0x${string}` });
      return "0xnever";
    },
  } as unknown as Signer;
}

describe("what Aave refuses", () => {
  const run = (recipe: typeof aaveSupply, wallets: Signer) =>
    recipe.execute({
      action: {} as never,
      input: { chain: "base", amount_usd: "250" },
      wallets,
      recordSent: async () => {},
      posting: (_chain, post) => post(),
    });

  it("is said in the owner's words when the node says the pool would revert", async () => {
    allowed = 250_000_000n;
    const full = await run(aaveSupply, refusedBy("supply-cap.json")).catch((error) => error);
    expect(full).toBeInstanceOf(Refused);
    expect([full.kind, full.message]).toEqual([
      "rule",
      expect.stringMatching(/^Aave's USDC savings on this chain are full/u),
    ]);
    const lentOut = await run(aaveWithdraw, refusedBy("lent-out.json")).catch((error) => error);
    expect([lentOut.kind, lentOut.message]).toEqual([
      "busy",
      expect.stringMatching(/^Aave's USDC pool on this chain has lent out/u),
    ]);
  });

  it("leaves a failure with no revert in it as it came, a send that may have gone above all", async () => {
    allowed = 250_000_000n;
    const mayHave = new MayHaveSent({ chain: "base", hash: "0x01" }, "Base", new Error("timeout"));
    const failing = (error: unknown) =>
      ({
        evmAddress: OWNER,
        sendEvmTransaction: async () => {
          throw error;
        },
      }) as unknown as Signer;
    await expect(run(aaveSupply, failing(mayHave))).rejects.toBe(mayHave);
    const reverted = new Error("The transaction reverted on base (0x02).");
    await expect(run(aaveSupply, failing(reverted))).rejects.toBe(reverted);
  });
});

// A run that stopped after its send, before its result was written, is read back by reconcile
// once the send confirmed.
describe("what Aave reads back of a move whose run stopped", () => {
  const context = { evmAddress: OWNER, solanaAddress: null };
  const input = { chain: "base" as const, amount_usd: "250" };

  /** A USDC transfer on Base, as a receipt logs it. */
  const usdcMoved = (from: string, to: string, units: bigint) => ({
    address: NETWORKS.base.usdc,
    topics: [
      toEventSelector("Transfer(address,address,uint256)"),
      pad(from as Hex),
      pad(to as Hex),
    ],
    data: encodeAbiParameters([{ type: "uint256" }], [units]),
  });

  it("reads a supply as the USDC its confirmed transaction took from the wallet", async () => {
    receipts.set("0xsupply", {
      status: "success",
      logs: [usdcMoved(OWNER, AAVE.base.aUsdc, 249_000_000n)],
    });
    const action = { txs: [{ chain: "base", hash: "0xsupply" }] } as never;
    expect(await aaveSupply.readBack!({ ...context, action, input })).toEqual({
      fills: [
        {
          chain: "base",
          instrument: AAVE.base.aUsdc,
          side: "buy",
          quantity: "249",
          usdValue: "249",
        },
      ],
    });
    // A send that never got an answer has no receipt, so nothing is read from what was asked.
    const unanswered = { txs: [{ chain: "base" }] } as never;
    expect(await aaveSupply.readBack!({ ...context, action: unanswered, input })).toBeNull();
  });

  it("reads a withdrawal as the USDC its transaction paid the wallet, interest included", async () => {
    receipts.set("0xwithdraw", {
      status: "success",
      logs: [usdcMoved(AAVE.base.aUsdc, OWNER, 250_410_000n)],
    });
    const action = { txs: [{ chain: "base", hash: "0xwithdraw" }] } as never;
    expect(await aaveWithdraw.readBack!({ ...context, action, input })).toMatchObject({
      fills: [{ side: "sell", quantity: "250.41", usdValue: "250.41" }],
    });
    // Nothing confirmed yet, nothing to read.
    expect(
      await aaveWithdraw.readBack!({ ...context, action: { txs: [] } as never, input }),
    ).toBeNull();
  });
});
