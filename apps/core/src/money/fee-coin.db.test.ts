import { NETWORKS } from "@auni/shared";
import { eq } from "drizzle-orm";
import { decodeFunctionData, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, fills, specialists } from "../db/schema.ts";
import { insertAction, insertSpecialist, insertThread, wipe } from "../test/db.ts";
import { executeAction, proposeAction, settleStopped } from "./actions.ts";
import { retryRefusal } from "./failure.ts";
import type { PayInRequest, PayInStanding } from "./pay-in.ts";
import { specialistPot } from "./pot.ts";
import { markCrashed } from "./record.ts";
import type { EvmTx, KeptTx } from "./recipe.ts";
import { recipeForTool } from "./recipes/index.ts";
import { retryAction } from "./retry.ts";
import type { SignerOptions } from "./wallets.ts";

// The coin a card buys for a chain's fees (fee-coin.ts), through the whole of a move's run:
// executeAction, the wallet's kept sends, a run that stops, and Try again. The drill beside
// Relay's app (apps/relay/fee-coin.held.test.ts) holds what is signed to the card; this holds
// how often: a card's purchase is made at most once, whatever happens after it.
//
// The world: a bridge out of Arbitrum, where the wallet holds cash and none of its ETH, on a
// card that showed buying the ETH with 15 MON from Monad through Relay.

const OWNER: Address = "0x2222222222222222222222222222222222222222";
const ARBITRUM = NETWORKS.arbitrum.viem.id;
const MONAD = NETWORKS.monad.viem.id;
const MON = 10n ** 18n;
const LACKS = 12n * 10n ** 12n;
const AMOUNT = 15n * MON;
const REQUEST: Hex = `0x${"ab".repeat(32)}`;
const PAYOUT = `0x${"cd".repeat(32)}`;

/** A pay-in service's depository, and the one call it takes, as an app says them (PayIn). */
const DEPOSITORY: Address = "0x4444444444444444444444444444444444444444";
const depository = parseAbi(["function depositNative(address depositor, bytes32 id) payable"]);
const deposit = (data: Hex, value: bigint) => ({
  depositor: decodeFunctionData({ abi: depository, data }).args[0],
  token: "native" as const,
  amount: value,
});

const world = vi.hoisted(() => ({
  /** What a send on each chain is short of its coin, in wei. */
  lacks: {} as Record<number, bigint>,
  coin: {} as Record<number, bigint>,
  /** Where Relay says the order stands, when asked. */
  relay: "success" as PayInStanding["status"],
  /** Whether the ETH shows in the wallet as the deposit lands. */
  pays: true,
  signed: [] as { chainId: number; txs: readonly EvmTx[] }[],
  /** Which way the stand-in move's money goes: a bridge of cash has none, a buy is "buy". */
  direction: null as "buy" | "sell" | null,
  /** What the move's own send throws, once. */
  moveThrows: null as Error | null,
  /** The run hangs here until the test lets go, as a process that dies does. */
  hangsAt: null as "payout" | null,
  hung: [] as (() => void)[],
}));

vi.mock("./portfolio.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  heldNow: async () => null,
}));
vi.mock(import("./chains.ts"), async (original) => ({
  ...(await original()),
  evmClient: ((chainId: number) => ({
    getBalance: async () => world.coin[chainId] ?? 0n,
    readContract: async () => 0n,
    getTransactionReceipt: async () => ({ status: "success" }),
  })) as never,
}));
// MON at 1.65 cents and ETH at $2,000.
vi.mock(import("./token-feeds.ts"), async (original) => ({
  ...(await original()),
  feedListing: (async (chain: string) => ({
    usdPrice: chain === "monad" ? 0.0165 : 2_000,
  })) as never,
}));
vi.mock(import("./funding.ts"), async (original) => ({
  ...(await original()),
  unpaid: async () => null,
}));
vi.mock(import("./gas.ts"), () => ({
  ownGas: vi.fn(async (chainId: number) => {
    const lacks = world.lacks[chainId];
    return lacks ? { short: "Too little ETH for gas.", fee: 1n, lacks } : { short: null, fee: 1n };
  }),
  ownGasFees: vi.fn(),
  assertOwnGas: vi.fn(),
  gasLimit: vi.fn(),
}));
// What the wallet held of a coin a move trades is counted before it (other-tokens.ts); here only
// what is asked of it, and when.
const counted = vi.hoisted(() => [] as { keys: readonly unknown[]; signedBefore: number }[]);
vi.mock(import("./other-tokens.ts"), async (original) => ({
  ...(await original()),
  countBeforeTrading: async (keys) => {
    counted.push({ keys, signedBefore: world.signed.length });
  },
}));
vi.mock("./wallets.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  evmAddress: async () => OWNER,
  paysOwnGas: async () => true,
  walletAddresses: async () => ({ evm: OWNER, solana: null }),
  // A wallet that keeps each send as a real one does: handed to `onSent` before it answers.
  signerFor: async (options: SignerOptions) => ({
    evmAddress: OWNER,
    solanaAddress: "",
    async sendEvmTransaction(chainId: number, tx: EvmTx | readonly EvmTx[]) {
      const txs = "to" in tx ? [tx] : tx;
      if (chainId === ARBITRUM && world.moveThrows) {
        const error = world.moveThrows;
        world.moveThrows = null;
        throw error;
      }
      world.signed.push({ chainId, txs });
      const hash = `0x${world.signed.length.toString(16).padStart(64, "0")}`;
      const kept: KeptTx = {
        chain: chainId === MONAD ? "monad" : "arbitrum",
        hash,
        ...(txs.every((each) => each.setup) ? { setup: true as const } : {}),
      };
      await options.onSent(kept);
      if (chainId === MONAD && world.pays) relayPays();
      return hash;
    },
  }),
}));
vi.mock(import("./pay-in.ts"), async (original) => {
  const real = await original();
  const standing = (): PayInStanding => ({
    status: world.relay,
    paidIn: world.relay === "success" ? [PAYOUT] : [],
  });
  return {
    ...real,
    // Relay's answer as the app hands it over, through core's own check of it.
    payInQuote: async (request: PayInRequest) =>
      real.checkedQuote(
        request,
        { name: "Relay", depository: DEPOSITORY, deposit },
        {
          steps: [
            {
              id: "deposit",
              kind: "transaction",
              description: "",
              requestId: REQUEST,
              calls: [
                {
                  chainId: MONAD,
                  to: DEPOSITORY,
                  value: request.amount,
                  data: encodeFunctionData({
                    abi: depository,
                    functionName: "depositNative",
                    args: [request.user, REQUEST],
                  }),
                },
              ],
            },
          ],
          pays: { recipient: request.recipient, chain: "arbitrum", token: "native" },
          out: 100n * LACKS,
          least: 99n * LACKS,
          gas: null,
          seconds: 2,
        },
      ),
    payInStanding: async () => standing(),
    payInSettled: async () => {
      if (world.hangsAt === "payout") {
        await new Promise<void>((resolve) => world.hung.push(resolve));
        throw new Error("the process died here");
      }
      return standing();
    },
  };
});

/** Relay's ETH shows in the wallet on Arbitrum, so a send there is short of nothing. */
function relayPays() {
  world.coin[ARBITRUM] = (world.coin[ARBITRUM] ?? 0n) + 10n * LACKS;
  world.lacks = {};
}

const calls: EvmTx[] = [
  { to: NETWORKS.arbitrum.usdc, data: "0x095ea7b3", setup: true },
  { to: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A", data: "0xad5425c6" },
];
/**
 * The move: Across's own recipe, by which every part of core knows the tool, standing in for
 * what it reads and sends: a bridge of cash by default, or a buy when a test says, that says
 * the calls its card would send (so core checks its fee and buys the coin on its card).
 */
const recipe = recipeForTool("bridge_usdc")!;
const INPUT = { from_chain: "arbitrum", to_chain: "monad", amount: "2" };
function standIn() {
  vi.spyOn(recipe, "direction").mockImplementation(() => world.direction);
  vi.spyOn(recipe, "readies").mockImplementation(() => null);
  vi.spyOn(recipe, "fundedFrom").mockImplementation(() => null);
  vi.spyOn(recipe, "about").mockImplementation(() => null);
  vi.spyOn(recipe, "describe").mockImplementation(async () => ({
    summary: "Buy $2 of a token on Arbitrum",
    amountUsd: "2",
    effect: { gives: [{ text: "$2 of USDC" }], gets: [{ text: "a token" }], grants: [] },
    sends: { chainId: ARBITRUM, calls },
  }));
  vi.spyOn(recipe, "execute").mockImplementation(async ({ wallets }) => {
    const hash = await wallets.sendEvmTransaction(ARBITRUM, calls);
    const bought = { chain: "arbitrum", instrument: "0xtoken", quantity: "1", usdValue: "2" };
    return {
      txs: [{ chain: "arbitrum", hash }],
      fills: world.direction === "buy" ? [{ ...bought, side: "buy" }] : [],
    };
  });
}

/** What the card pinned of its purchase (withFeeCoin). */
const CARD = {
  feeCoinOn: "arbitrum",
  feeCoinFrom: "monad",
  feeCoinToken: "native",
  feeCoinAmount: AMOUNT.toString(),
  feeCoinUsd: "0.25",
  feeCoinBy: "Relay",
};

const allowed = () =>
  insertAction({ tool: "bridge_usdc", input: INPUT, details: CARD, status: "running" });
const row = async (id: string) => (await db.select().from(actions).where(eq(actions.id, id)))[0]!;
const purchases = () => world.signed.filter(({ chainId }) => chainId === MONAD);
const moves = () => world.signed.filter(({ chainId }) => chainId === ARBITRUM);

/** The owner's tap on Try again, and the run it queues. */
async function tryAgain(id: string) {
  const failed = await row(id);
  expect(await retryAction(failed, failed.attempts)).toEqual({ kind: "running" });
  return executeAction(id);
}

beforeEach(async () => {
  standIn();
  await wipe(specialists, actions, fills);
  world.lacks = { [ARBITRUM]: LACKS };
  world.coin = { [MONAD]: 67n * MON };
  world.relay = "success";
  world.pays = true;
  world.signed = [];
  world.direction = null;
  world.moveThrows = null;
  world.hangsAt = null;
  world.hung = [];
  counted.length = 0;
});

describe("the coin a card buys for its fees, through a move's whole run", () => {
  it("buys once, exactly what the card showed, keeps it as the card's purchase, then sends the move", async () => {
    const { id } = await allowed();
    const done = await executeAction(id);
    expect(done.status).toBe("done");
    expect(purchases()).toHaveLength(1);
    expect(purchases()[0]!.txs).toMatchObject([
      { to: DEPOSITORY, value: AMOUNT.toString(), setup: true },
    ]);
    expect(moves()).toEqual([{ chainId: ARBITRUM, txs: calls }]);
    // The deposit is kept as this card's purchase, by Relay's id for it; then what Relay paid
    // the wallet with; then the move itself.
    expect(done.txs).toMatchObject([
      { chain: "monad", setup: true, buysFees: REQUEST },
      { chain: "arbitrum", hash: PAYOUT, setup: true, buysFees: REQUEST },
      { chain: "arbitrum" },
    ]);
    expect(done.txs[2]).not.toHaveProperty("setup");
  });

  // A chain's first look at its own coin counts what the wallet holds of it as put in; made
  // after the purchase, it would count the coin bought, or miss the coin paid, as made or lost.
  it("counts the coin it buys and the coin it pays with from before the purchase", async () => {
    const { id } = await allowed();
    await executeAction(id);
    expect(counted).toEqual([
      {
        keys: expect.arrayContaining([
          { chain: "arbitrum", instrument: "native" },
          { chain: "monad", instrument: "native" },
        ]),
        signedBefore: 0,
      },
    ]);
  });

  it("buys nothing where the send isn't short by then", async () => {
    world.lacks = {};
    const { id } = await allowed();
    expect((await executeAction(id)).status).toBe("done");
    expect(purchases()).toHaveLength(0);
    expect(moves()).toHaveLength(1);
  });

  it("never buys again on Try again, however often, once Relay took the deposit and paid nothing", async () => {
    world.relay = "failed";
    world.pays = false;
    const { id } = await allowed();
    const stopped = await executeAction(id);
    // Not "nothing moved": a state of its own, which says what went and to whom.
    expect(stopped).toMatchObject({ status: "failed", failureKind: "fees" });
    expect(stopped.error).toBe(
      "Relay has the 15 MON this card sent it from Monad, paid no ETH, and says it can't refund it by itself. The move wasn't sent. Ask Auni for the order's id to take up with Relay.",
    );
    expect(retryRefusal(stopped)).toBeNull();
    for (const attempts of [2, 3, 4]) {
      const again = await tryAgain(id);
      expect(again).toMatchObject({ status: "failed", failureKind: "fees", attempts });
    }
    expect(purchases()).toHaveLength(1);
    expect(moves()).toHaveLength(0);
    expect((await row(id)).txs.filter((tx) => tx.buysFees)).toHaveLength(1);
  });

  it("says a refund as a refund, and still buys nothing more under the same card", async () => {
    world.relay = "refunded";
    world.pays = false;
    const { id } = await allowed();
    const stopped = await executeAction(id);
    expect(stopped.failureKind).toBe("fees");
    expect(stopped.error).toBe(
      "Relay refunded the 15 MON this card sent it from Monad rather than pay the ETH, so the move wasn't sent. Ask Auni for it again: a new card shows what it buys.",
    );
    expect((await tryAgain(id)).error).toBe(stopped.error);
    expect(purchases()).toHaveLength(1);
  });

  it("runs the move on Try again once a late payout has come, with nothing bought twice", async () => {
    world.relay = "pending";
    world.pays = false;
    const { id } = await allowed();
    const stopped = await executeAction(id);
    expect(stopped).toMatchObject({ status: "failed", failureKind: "fees" });
    expect(stopped.error).toBe(
      "Relay has the 15 MON this card sent it from Monad and hasn't paid the ETH yet. It pays or refunds by itself. Try again once the ETH is there: nothing more is bought.",
    );
    // Still not there: the tap sends nothing at all.
    expect((await tryAgain(id)).failureKind).toBe("fees");
    expect(world.signed).toHaveLength(1);
    // Relay pays late.
    relayPays();
    const done = await tryAgain(id);
    expect(done.status).toBe("done");
    expect(purchases()).toHaveLength(1);
    expect(moves()).toHaveLength(1);
  });

  it("buys nothing more when the move's own send failed after the purchase and the fee rose past it", async () => {
    world.moveThrows = new Error("fetch failed");
    const { id } = await allowed();
    const stopped = await executeAction(id);
    expect(stopped).toMatchObject({ status: "failed", failureKind: "glitch" });
    expect(purchases()).toHaveLength(1);
    // The fee rose: the ETH the card bought no longer covers the send.
    world.lacks = { [ARBITRUM]: LACKS };
    const again = await tryAgain(id);
    expect(again.failureKind).toBe("fees");
    expect(again.error).toBe(
      "The ETH this card bought through Relay no longer covers the network fee, and a card buys once. Ask Auni for it again: a new card shows what it buys.",
    );
    expect(purchases()).toHaveLength(1);
    expect(moves()).toHaveLength(0);
  });

  it("buys once in a run, though a later send of that run on the chain is short again", async () => {
    // A move that sends twice on Arbitrum, an approval and then the deposit, while the fee
    // rises between them past what the purchase covered.
    vi.spyOn(recipe, "execute").mockImplementation(async ({ wallets }) => {
      await wallets.sendEvmTransaction(ARBITRUM, [calls[0]!]);
      world.lacks = { [ARBITRUM]: LACKS };
      const hash = await wallets.sendEvmTransaction(ARBITRUM, [calls[1]!]);
      return { txs: [{ chain: "arbitrum", hash }], fills: [] };
    });
    const { id } = await allowed();
    expect((await executeAction(id)).status).toBe("done");
    expect(purchases()).toHaveLength(1);
    expect(moves()).toHaveLength(2);
  });

  it("is left as sent, never run again, when the process dies between the purchase and the move", async () => {
    world.hangsAt = "payout";
    const { id } = await allowed();
    void executeAction(id).catch(() => {});
    await vi.waitFor(() => expect(world.hung).toHaveLength(1));
    // The restart: the action job's cutShort (jobs/action.ts).
    const after = await settleStopped(await markCrashed(id));
    expect(after).toMatchObject({ status: "failed", failureKind: "sent" });
    expect(retryRefusal(after)).toBe("not_retryable");
    expect(await retryAction(after, after.attempts)).toEqual({
      kind: "refused",
      reason: "not_retryable",
    });
    expect(purchases()).toHaveLength(1);
    expect(moves()).toHaveLength(0);
  });

  it("signs nothing more for a job delivered again after the claim", async () => {
    const { id } = await allowed();
    await Promise.all([executeAction(id), executeAction(id), executeAction(id)]);
    expect(purchases()).toHaveLength(1);
    expect(moves()).toHaveLength(1);
  });

  it("says each state in a sentence the card can show whole", async () => {
    for (const relay of ["pending", "refunded", "failed"] as const) {
      await wipe(actions);
      world.relay = relay;
      world.pays = false;
      world.lacks = { [ARBITRUM]: LACKS };
      const { id } = await allowed();
      const { error } = await executeAction(id);
      // What the web takes for a sentence a person can read (readableError in move-rows.ts).
      expect(error).toMatch(/^[A-Z][^{}[\]]{0,200}\.$/u);
    }
  });
});

describe("a specialist that acts on its own, and the coin its move would buy for fees", () => {
  /** A specialist set to act on its own within `potUsd`, proposing the stand-in buy of $2 in its own thread. */
  async function proposes(potUsd: string) {
    world.direction = "buy";
    world.coin = { [MONAD]: 1_000n * MON };
    const specialist = await insertSpecialist({ potUsd, actMode: "within_limits" });
    const own = await insertThread({ specialistId: specialist.id });
    const outcome = await proposeAction(
      { threadId: own.id, specialistId: specialist.id },
      recipe,
      INPUT,
    );
    const free = async () =>
      (await db.transaction((tx) => specialistPot(tx, specialist))).freeCashCents;
    return { outcome, free };
  }

  it("asks the owner where the move and its purchase don't both fit the pot", async () => {
    // Short 0.001 ETH, $2 of it, so the card buys $3 of ETH with MON: $5 in all, from a $2 pot.
    world.lacks = { [ARBITRUM]: 10n ** 15n };
    const { outcome } = await proposes("2");
    expect(outcome.action.details).toMatchObject({ feeCoinUsd: "3.00", feeCoinFrom: "monad" });
    expect(outcome.status).toBe("awaiting_permission");
    expect(world.signed).toEqual([]);
  });

  it("runs unasked where both fit, and counts the purchase in the pot from then on", async () => {
    // Short a few cents, so the card buys a quarter of a dollar: $2.25 in all, from a $5 pot.
    const { outcome, free } = await proposes("5");
    expect(outcome.action.details).toMatchObject({ feeCoinUsd: "0.25" });
    expect(outcome.status).toBe("running");
    // Spoken for while it runs: the buy and what its card may spend on fees.
    expect(await free()).toBe(275n);
    const done = await executeAction(outcome.action.id);
    expect(done.status).toBe("done");
    expect(purchases()).toHaveLength(1);
    // Spent for good: $2 into the holding, 25 cents to Relay.
    expect(await free()).toBe(275n);
  });

  it("counts no purchase a move turned out not to need", async () => {
    const { outcome, free } = await proposes("5");
    // By the time it runs the wallet can pay the fee itself.
    world.lacks = {};
    expect((await executeAction(outcome.action.id)).status).toBe("done");
    expect(purchases()).toHaveLength(0);
    expect(await free()).toBe(300n);
  });
});
