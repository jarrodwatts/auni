import { describe, expect, it, vi } from "vitest";

import { walletsFor } from "../../test/wallets.ts";
import { MayHaveSent, type KeptTx } from "../../money/recipe.ts";
import { CONTRACTS, relayerRequest, VenueError } from "./http.ts";
import { relayed, runBatch } from "./relayer.ts";

vi.mock(import("./http.ts"), async (original) => ({
  ...(await original()),
  relayerRequest: vi.fn(),
}));

const WALLET = "0x2222222222222222222222222222222222222222";

describe("runBatch", () => {
  it("keeps the batch by the relayer's id before it can land, then by its hash", async () => {
    const kept: KeptTx[] = [];
    vi.mocked(relayerRequest).mockImplementation(async (_method, path) => {
      if (path === "/v1/account/transactions/params") return { nonce: "3" };
      if (path === "/submit") return { transactionID: "relay-1" };
      // The chain may report the pull before the relayer confirms it: by then it is kept.
      expect(kept).toEqual([{ chain: "polygon", relayerId: "relay-1", setup: true }]);
      return { state: "STATE_CONFIRMED", transaction_hash: "0xpull" };
    });

    const hash = await runBatch(
      walletsFor(`0x${"11".repeat(32)}`),
      WALLET,
      {
        calls: [],
        funding: { calls: [{ target: CONTRACTS.usdce, data: "0xdeadbeef" }] },
        metadata: "auni trading setup",
        setup: true,
      },
      async (tx) => void kept.push(tx),
    );

    expect(hash).toBe("0xpull");
    expect(kept).toEqual([
      { chain: "polygon", relayerId: "relay-1", setup: true },
      { chain: "polygon", relayerId: "relay-1", setup: true, hash: "0xpull" },
    ]);
  });
});

describe("relayed", () => {
  it("says a transaction is confirmed only with its hash, failed with why, or pending", async () => {
    const answer = (state: string, more = {}) =>
      vi.mocked(relayerRequest).mockResolvedValueOnce({ state, ...more });
    answer("STATE_CONFIRMED", { transaction_hash: "0xa" });
    answer("STATE_CONFIRMED");
    answer("STATE_MINED", { transaction_hash: "0xa" });
    answer("STATE_FAILED", { error_msg: "reverted" });
    expect(await relayed("r")).toEqual({ hash: "0xa" });
    expect(await relayed("r")).toBe("pending");
    // Mined can be re-reported after a reorg, so only confirmed settles.
    expect(await relayed("r")).toBe("pending");
    expect(await relayed("r")).toEqual({ failed: "reverted" });
  });
});

describe("a batch that is the move itself", () => {
  const send = (kept: KeptTx[], setup: boolean) =>
    runBatch(
      walletsFor(`0x${"11".repeat(32)}`),
      WALLET,
      {
        calls: [{ target: CONTRACTS.pusd, data: "0xdeadbeef" }],
        metadata: "auni cash home",
        setup,
      },
      async (tx) => void kept.push(tx),
    );
  /** The relayer hands out a nonce, then answers the submit with `submitted`. */
  const relayer = (submitted: () => Promise<unknown>) =>
    vi.mocked(relayerRequest).mockImplementation(async (_method, path) => {
      if (path === "/v1/account/transactions/params") return { nonce: "3" };
      if (path === "/submit") return submitted();
      return { state: "STATE_CONFIRMED", transaction_hash: "0xhome" };
    });

  it("is kept as a send of the move, by the relayer's id and then its hash", async () => {
    const kept: KeptTx[] = [];
    relayer(async () => ({ transactionID: "relay-2" }));
    expect(await send(kept, false)).toBe("0xhome");
    expect(kept).toEqual([
      { chain: "polygon", relayerId: "relay-2" },
      { chain: "polygon", relayerId: "relay-2", hash: "0xhome" },
    ]);
  });

  it("may have gone when the relayer gave no answer or a server error, and is never failed on that guess", async () => {
    for (const noAnswer of [
      new VenueError("Polymarket relayer", 502, "bad gateway"),
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    ]) {
      const kept: KeptTx[] = [];
      relayer(async () => {
        throw noAnswer;
      });
      const stopped = await send(kept, false).catch((error: unknown) => error);
      expect(stopped).toBeInstanceOf(MayHaveSent);
      // Kept by the action with nothing to read it by, so the move is unsure, never run again.
      expect((stopped as MayHaveSent).sent).toEqual({ chain: "polygon" });
      expect(kept).toEqual([]);
    }
  });

  it("was turned away when the relayer answers a 4xx, in the relayer's words, so nothing moved", async () => {
    const kept: KeptTx[] = [];
    relayer(async () => {
      throw new VenueError("Polymarket relayer", 429, '{"error":"quota exceeded"}');
    });
    const refused = await send(kept, false).catch((error: unknown) => error);
    expect(refused).not.toBeInstanceOf(MayHaveSent);
    expect((refused as Error).message).toContain("has taken as many transactions from this Auni");
    expect(kept).toEqual([]);
  });

  it("is told apart from a setup batch, which fails as before when it gets no answer", async () => {
    relayer(async () => {
      throw new VenueError("Polymarket relayer", 502, "bad gateway");
    });
    const failed = await send([], true).catch((error: unknown) => error);
    expect(failed).not.toBeInstanceOf(MayHaveSent);
  });

  it("asks the relayer once: a submit is never tried again", async () => {
    relayer(async () => {
      throw new VenueError("Polymarket relayer", 502, "bad gateway");
    });
    vi.mocked(relayerRequest).mockClear();
    await send([], false).catch(() => {});
    const submits = vi.mocked(relayerRequest).mock.calls.filter(([, path]) => path === "/submit");
    expect(submits).toHaveLength(1);
  });
});
