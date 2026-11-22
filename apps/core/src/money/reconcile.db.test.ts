import { EVM_CASH_KEYS } from "@auni/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { actions } from "../db/schema.ts";
import { theWallet } from "../apps/registry.ts";
import { insertAction, wipe } from "../test/db.ts";
import { evmClient } from "./chains.ts";
import { settleFromReceipts } from "./reconcile.ts";

vi.mock("./chains.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  evmClient: vi.fn(),
}));
// The wallet, and a venue whose relayer took the sends it keeps by the relayer's id.
const relayed = vi.hoisted(() => vi.fn());
vi.mock("../apps/registry.ts", async (importOriginal) => {
  const sendStatus = vi.fn();
  return {
    ...(await importOriginal<object>()),
    theWallet: () => ({ sendStatus }),
    appById: (id: string) => (id === "relaying" ? { relayed } : undefined),
  };
});

beforeEach(() => wipe(actions));

describe("settleFromReceipts", () => {
  // A buy that stopped waiting on its funding batch, the relayer's id all it kept.
  const stoppedBuy = async () =>
    insertAction({
      tool: "polymarket_order",
      venue: "relaying",
      startedAt: new Date(Date.now() - 60 * 60_000),
      txs: [{ chain: "polygon", relayerId: "r1", setup: true }],
    });

  it("waits on a relayed send the relayer hasn't settled", async () => {
    vi.mocked(relayed).mockResolvedValue("pending");
    expect(await settleFromReceipts(await stoppedBuy())).toBeNull();
  });

  it("fails a buy whose relayed setup failed, as nothing moved", async () => {
    vi.mocked(relayed).mockResolvedValue("failed");
    expect(await settleFromReceipts(await stoppedBuy())).toMatchObject({ status: "failed" });
  });

  it("keeps a relayed send's hash once the relayer names it, and reads its receipt", async () => {
    vi.mocked(relayed).mockResolvedValue({ hash: "0xpull" });
    vi.mocked(evmClient).mockReturnValue({
      getTransactionReceipt: async () => ({ status: "success" }),
    } as never);
    // Only its setup landed, so the buy itself never went: it fails, its pull kept.
    expect(await settleFromReceipts(await stoppedBuy())).toMatchObject({
      status: "failed",
      txs: [
        { chain: "polygon", relayerId: "r1", setup: true },
        { chain: "polygon", relayerId: "r1", setup: true, hash: "0xpull" },
      ],
    });
  });

  // With every real app installed: Polymarket keeps its money on Polygon and Aave on each
  // cash chain, and neither makes its chain a place whose sends need no receipt.
  describe("a send that reverted", () => {
    const reverting = () => {
      const getTransactionReceipt = vi.fn(async () => ({ status: "reverted" }));
      vi.mocked(evmClient).mockReturnValue({ getTransactionReceipt } as never);
      return getTransactionReceipt;
    };
    const sent = (
      tool: string,
      venue: string | null,
      chain: string,
      input: Record<string, unknown> = {},
    ) =>
      insertAction({
        tool,
        venue,
        input,
        startedAt: new Date(Date.now() - 60 * 60_000),
        txs: [{ chain, hash: `0x${"ab".repeat(32)}` }],
      });

    it.each(EVM_CASH_KEYS)("on %s is read from the chain and fails as reverted", async (chain) => {
      const asked = reverting();
      for (const [tool, venue, input] of [
        ["send_evm_transaction", null, {}],
        ["aave_supply", "aave", { chain, amount_usd: "10" }],
        ["polymarket_order", "polymarket", { side: "buy" }],
        ["bridge_usdc", "across", { from_chain: chain, to_chain: "solana", amount: "10" }],
      ] as const) {
        expect(await settleFromReceipts(await sent(tool, venue, chain, input)), tool).toMatchObject(
          {
            status: "failed",
            failureKind: "sent",
            error: "Its transactions didn't go through, so nothing moved.",
          },
        );
      }
      expect(asked).toHaveBeenCalledTimes(4);
    });

    it("is never asked of a ledger of an app's own, which has no receipts", async () => {
      const asked = reverting();
      expect(
        await settleFromReceipts(await sent("hyperliquid_deposit", "hyperliquid", "hyperliquid")),
      ).toMatchObject({ status: "done" });
      expect(asked).not.toHaveBeenCalled();
    });
  });

  describe("a send its wallet kept by its own id", () => {
    const sendStatus = () => vi.mocked(theWallet().sendStatus);
    const sentSwap = async (kept: { hash?: string }) =>
      insertAction({
        tool: "send_evm_transaction",
        startedAt: new Date(Date.now() - 60 * 60_000),
        txs: [{ chain: "base", walletTxId: "j1", ...kept }],
      });
    const chainKnows = (status: "success" | null) =>
      vi.mocked(evmClient).mockReturnValue({
        getTransactionReceipt: async () => {
          if (status) return { status };
          const { TransactionReceiptNotFoundError } = await import("viem");
          throw new TransactionReceiptNotFoundError({ hash: "0x1" });
        },
      } as never);

    beforeEach(() => sendStatus().mockReset());

    it("reads the chain first, and asks the wallet nothing once it has a receipt", async () => {
      chainKnows("success");
      expect(await settleFromReceipts(await sentSwap({ hash: "0x1" }))).toMatchObject({
        status: "done",
      });
      expect(sendStatus()).not.toHaveBeenCalled();
    });

    it("asks the wallet about one the chain doesn't know, which may send it again", async () => {
      chainKnows(null);
      sendStatus().mockResolvedValue("pending");
      expect(await settleFromReceipts(await sentSwap({ hash: "0x1" }))).toBeNull();
      expect(sendStatus()).toHaveBeenCalledWith("j1");
    });

    it("fails it, nothing moved, when the wallet says it never lands", async () => {
      chainKnows(null);
      sendStatus().mockResolvedValue("failed");
      expect(await settleFromReceipts(await sentSwap({ hash: "0x1" }))).toMatchObject({
        status: "failed",
      });
    });

    it("keeps the hash the wallet names for one kept before it had one", async () => {
      chainKnows("success");
      sendStatus().mockResolvedValue({ hash: "0x2" });
      expect(await settleFromReceipts(await sentSwap({}))).toMatchObject({
        status: "done",
        txs: [
          { chain: "base", walletTxId: "j1" },
          { chain: "base", walletTxId: "j1", hash: "0x2" },
        ],
      });
    });

    // A local-key send stuck behind its fee is re-signed at a higher one (local-key/evm.ts).
    it("keeps the hash of the send that replaced it, and settles from its receipt", async () => {
      vi.mocked(evmClient).mockReturnValue({
        getTransactionReceipt: async ({ hash }: { hash: string }) => {
          if (hash === "0x2") return { status: "success" };
          const { TransactionReceiptNotFoundError } = await import("viem");
          throw new TransactionReceiptNotFoundError({ hash: hash as `0x${string}` });
        },
      } as never);
      sendStatus().mockResolvedValue({ hash: "0x2" });
      const settled = await settleFromReceipts(await sentSwap({ hash: "0x1" }));
      expect(settled).toMatchObject({
        status: "done",
        txs: [
          { chain: "base", walletTxId: "j1", hash: "0x1" },
          { chain: "base", walletTxId: "j1", hash: "0x2" },
        ],
      });
      // Read again, the replacement alone decides it.
      sendStatus().mockClear();
      expect(await settleFromReceipts({ ...settled!, status: "running" })).toMatchObject({
        status: "done",
      });
      expect(sendStatus()).not.toHaveBeenCalled();
    });
  });
});
