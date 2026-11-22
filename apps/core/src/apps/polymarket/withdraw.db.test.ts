import { HELD } from "@auni/shared";
import { eq } from "drizzle-orm";
import type { Address } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../../db/client.ts";
import { actions, fills } from "../../db/schema.ts";
import { actionJob } from "../../jobs/action.ts";
import { executeAction } from "../../money/actions.ts";
import { evmClient } from "../../money/chains.ts";
import { retryRefusal } from "../../money/failure.ts";
import { simulateEffect } from "../../money/wallet-effect.ts";
import { insertAction, wipe } from "../../test/db.ts";
import { CONTRACTS, relayerRequest, VenueError } from "./http.ts";
import { polymarketWithdraw } from "./withdraw.ts";

// A withdrawal's whole life with a real database under it, from the claim to however it ends,
// with the chain and Polymarket's relayer stood in: whatever the relayer answers, and wherever
// a run is cut off, the batch is handed to the relayer at most once.

const HASH = `0x${"ab".repeat(32)}`;

vi.mock(import("./wallet.ts"), async (original) => ({
  ...(await original()),
  depositWallet: vi.fn(async () => ({
    address: "0x2222222222222222222222222222222222222222" as Address,
    deployed: true,
  })),
  erc20Balance: vi.fn(async () => 80_000_000n),
}));
vi.mock(import("../../money/wallet-effect.ts"), async (original) => ({
  ...(await original()),
  simulateEffect: vi.fn(),
}));
vi.mock(import("../../money/chains.ts"), async (original) => ({
  ...(await original()),
  evmClient: vi.fn(),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => {
  const { walletsFor } = await import("../../test/wallets.ts");
  const wallets = walletsFor(`0x${"11".repeat(32)}`);
  return {
    ...(await original()),
    signerFor: async () => wallets,
    evmAddress: async () => wallets.evmAddress,
    walletAddresses: async () => ({ evm: wallets.evmAddress, solana: null }),
  };
});
vi.mock(import("./http.ts"), async (original) => ({
  ...(await original()),
  relayerRequest: vi.fn(),
}));

/** What the relayer answers a submit with, and what it then says became of the transaction. */
function relayer(
  submitted: () => Promise<unknown>,
  became: { state: string; transaction_hash?: string; error_msg?: string } = {
    state: "STATE_CONFIRMED",
    transaction_hash: HASH,
  },
) {
  vi.mocked(relayerRequest).mockReset();
  vi.mocked(relayerRequest).mockImplementation(async (_method, path) => {
    if (path === "/v1/account/transactions/params") return { nonce: "7" };
    if (path === "/submit") return submitted();
    return became;
  });
}
const submits = () =>
  vi.mocked(relayerRequest).mock.calls.filter(([, path]) => path === "/submit").length;
const taken = async () => ({ transactionID: "relay-1" });
const chainSays = (status: "success" | "reverted") =>
  vi
    .mocked(evmClient)
    .mockReturnValue({ getTransactionReceipt: async () => ({ status }) } as never);

/** A withdrawal of $20 the owner allowed, as its card was drawn while the pool paid $19.9992. */
async function allowed(fields: Partial<typeof actions.$inferInsert> = {}) {
  const card = await polymarketWithdraw.describe({ amountUsd: 20 }, {});
  return insertAction({
    tool: "polymarket_withdraw",
    venue: "polymarket",
    summary: card.summary,
    amountUsd: card.amountUsd,
    input: { amountUsd: 20 },
    details: card.details,
    ...fields,
  });
}
const rowOf = async (id: string) => (await db.select().from(actions).where(eq(actions.id, id)))[0]!;
/** The action job's `cutShort`, as the runner calls it for a job whose run was cut off. */
const cutOff = (actionId: string) =>
  actionJob.cutShort!(
    { actionId, lane: actionId, holding: actionId },
    { id: "cut", createdAt: new Date(), attempts: 1, signal: AbortSignal.abort() },
    "crashed",
  );

beforeEach(async () => {
  await wipe(actions, fills);
  vi.mocked(simulateEffect).mockResolvedValue({
    out: [],
    in: [{ token: CONTRACTS.usdc, amount: 19_999_240n }],
    grants: [],
    blind: false,
    logs: [],
  });
  chainSays("success");
});

describe("a Polymarket withdrawal's life", () => {
  it("is done once the relayer confirms it, kept as the move by the relayer's id and its hash", async () => {
    relayer(taken);
    const { id } = await allowed();
    expect(await executeAction(id)).toMatchObject({
      status: "done",
      txs: [
        // The mark kept before the batch went, which the relayer's id then speaks for.
        { chain: "polygon" },
        { chain: "polygon", relayerId: "relay-1" },
        { chain: "polygon", relayerId: "relay-1", hash: HASH },
      ],
    });
    // Its job delivered again, it is left as it is.
    expect(await executeAction(id)).toMatchObject({ status: "done" });
    expect(submits()).toBe(1);
    // Cash moving between the owner's own places is no trade.
    expect(await db.select().from(fills)).toEqual([]);
  });

  it("is held, never failed, when the relayer gave the batch no answer, and nothing sends it again", async () => {
    relayer(async () => {
      throw new VenueError("Polymarket relayer", 502, "bad gateway");
    });
    const { id } = await allowed();
    const held = await executeAction(id);
    // Kept as a send with nothing to read it by, which only the owner's Close ends.
    expect(held).toMatchObject({
      status: "running",
      phase: "needs_owner",
      error: HELD.unanswered,
      txs: [{ chain: "polygon" }],
    });
    expect(retryRefusal(held)).toBe("not_failed");
    await executeAction(id);
    await cutOff(id);
    expect(await rowOf(id)).toMatchObject({ phase: "needs_owner" });
    expect(submits()).toBe(1);
  });

  it("fails with nothing kept when the relayer turns the batch away, and can be tried again", async () => {
    relayer(async () => {
      throw new VenueError("Polymarket relayer", 429, '{"error":"quota exceeded"}');
    });
    const { id } = await allowed();
    const failed = await executeAction(id);
    expect(failed).toMatchObject({ status: "failed", failureKind: "busy", txs: [] });
    expect(failed.error).toContain("has taken as many transactions from this Auni");
    expect(retryRefusal(failed)).toBeNull();
  });

  it("settles from the relayer's own record when its run was cut off after the relayer took the batch", async () => {
    relayer(taken);
    const { id } = await allowed({
      startedAt: new Date(),
      txs: [{ chain: "polygon" }, { chain: "polygon", relayerId: "relay-1" }],
    });
    await cutOff(id);
    expect(await rowOf(id)).toMatchObject({
      status: "done",
      txs: [
        { chain: "polygon" },
        { chain: "polygon", relayerId: "relay-1" },
        { chain: "polygon", relayerId: "relay-1", hash: HASH },
      ],
    });
    expect(submits()).toBe(0);
  });

  it("fails as sent, never to run again as it is, when the relayer says the batch failed on chain", async () => {
    relayer(taken, { state: "STATE_FAILED", error_msg: "execution reverted" });
    const { id } = await allowed();
    const failed = await executeAction(id);
    expect(failed).toMatchObject({ status: "failed", failureKind: "sent" });
    expect(failed.error).toContain("failed on chain, so nothing moved: execution reverted");
    expect(retryRefusal(failed)).toBe("not_retryable");
    expect(submits()).toBe(1);
  });

  it("never runs again on a tap when its run was cut off before the relayer answered", async () => {
    relayer(taken);
    const { id } = await allowed({ startedAt: new Date() });
    await cutOff(id);
    const stopped = await rowOf(id);
    expect(stopped).toMatchObject({ status: "failed", failureKind: "sent", txs: [] });
    expect(retryRefusal(stopped)).toBe("not_retryable");
    await executeAction(id);
    expect(submits()).toBe(0);
  });
});
