import type { VenueToolName } from "@auni/shared";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, specialists, fills, messages, threads } from "../db/schema.ts";
import type { Account, Payout } from "../apps/contract.ts";
import { standIn } from "../apps/registry.ts";
import { insertAction, insertSpecialist, insertThread, wipe } from "../test/db.ts";
import type { FillKey } from "./fill-key.ts";
import { specialistFlows, madeUsd } from "./made.ts";
import { readActivity } from "./activity.ts";
import { payoutSweeps } from "./payouts.ts";

const OWNER = "0x1111111111111111111111111111111111111111";
const HASH = `0x${"cd".repeat(32)}`;
// A tool Activity knows as a payout, kept by the fake market in its place.
const TOOL = "polymarket_payout" satisfies VenueToolName;
const YES: FillKey = { chain: "polygon", instrument: "111" };
const NO: FillKey = { chain: "polygon", instrument: "222" };
const SHARE = 10n ** 12n;

/** A prediction market of its own, which pays out whatever `paid` says. */
const market = vi.hoisted(() => ({
  paid: [] as Payout[],
  payouts: vi.fn(),
}));
/** The fake market's account, the only one installed: its outcomes are numbers on Polygon. */
beforeAll(() =>
  standIn(() => [
    {
      about: { id: "fakemarket", name: "Fake Market" },
      account: {
        kept: {
          chains: ["polygon"],
          read: async () => [],
          owns: (key: FillKey) => /^\d+$/u.test(key.instrument),
        },
        payouts: { tool: TOOL, read: market.payouts },
      } as unknown as Account,
    },
  ]),
);
afterAll(() => standIn((real) => real));

beforeEach(async () => {
  await wipe(specialists, actions, fills, messages, threads);
  market.paid = [];
  market.payouts.mockReset();
  market.payouts.mockImplementation(
    async (_owner: string, _open: Set<string>, _since: number, recorded: Set<string>) =>
      market.paid.filter((payout) => !payout.hash || !recorded.has(payout.hash)),
  );
});

const record = () => Promise.all(payoutSweeps(OWNER).map(({ run }) => run()));

/** The market paying `paidMicros` in one transaction, for each share it burned. */
function paying(paidMicros: bigint, shares: Payout["markets"][number]["shares"]) {
  market.paid = [
    { hash: HASH, chain: "polygon", markets: [{ question: "Will it rain?", paidMicros, shares }] },
  ];
}

/** A done buy at the market, filled for `specialistId` or loose. */
async function bought(
  specialistId: string | null,
  key: FillKey,
  quantity: string,
  usdValue: string,
  threadId: string | null = null,
) {
  const action = await insertAction({
    tool: "fakemarket_order",
    venue: "fakemarket",
    status: "done",
    specialistId,
    threadId,
  });
  await db
    .insert(fills)
    .values({ actionId: action.id, specialistId, side: "buy", quantity, usdValue, ...key });
}

function payoutFills() {
  return db
    .select({
      specialistId: fills.specialistId,
      instrument: fills.instrument,
      side: fills.side,
      quantity: fills.quantity,
      usdValue: fills.usdValue,
    })
    .from(fills)
    .innerJoin(actions, eq(actions.id, fills.actionId))
    .where(eq(actions.tool, TOOL))
    .orderBy(asc(fills.usdValue));
}

describe("recording what a prediction market paid out", () => {
  it("closes a specialist's position at its payout, as a done move with its hash", async () => {
    const rain = await insertSpecialist();
    await bought(rain.id, YES, "10", "6.00");
    paying(10_000_000n, [{ key: YES, burned: 10n * 10n ** 18n, paidMicros: 10_000_000n }]);

    await record();

    const [payout] = await db.select().from(actions).where(eq(actions.tool, TOOL));
    expect(payout).toMatchObject({
      status: "done",
      venue: "fakemarket",
      summary: 'Fake Market paid out $10 for "Will it rain?"',
      txs: [{ chain: "polygon", hash: HASH }],
    });
    expect(await payoutFills()).toEqual([
      {
        specialistId: rain.id,
        instrument: YES.instrument,
        side: "sell",
        quantity: "10.000000000000000000",
        usdValue: "10.00",
      },
    ]);
    // Bought for $6, paid $10, and nothing left: $4 made.
    const flows = (await specialistFlows([rain.id])).get(rain.id) ?? [];
    expect(madeUsd(0, 0, flows)).toBe("4.00");
  });

  it("records a payout once, however often it is read or by how many at once", async () => {
    const rain = await insertSpecialist();
    await bought(rain.id, YES, "10", "6.00");
    paying(10_000_000n, [{ key: YES, burned: 10n * 10n ** 18n, paidMicros: 10_000_000n }]);

    await Promise.all([record(), record()]);
    await record();

    expect(await db.select().from(actions).where(eq(actions.tool, TOOL))).toHaveLength(1);
    expect(await payoutFills()).toHaveLength(1);
  });

  it("tells a payout once, in the chat the shares were bought in", async () => {
    // Live, 2026-11-16: a $1 bet on Bitcoin's hour paid out, and nothing was said.
    const chat = await insertThread({ title: "Bitcoin's hour" });
    await bought(null, YES, "1.004", "1.00", chat.id);
    paying(1_004_000n, [{ key: YES, burned: 1_004_000n * SHARE, paidMicros: 1_004_000n }]);

    await Promise.all([record(), record()]);
    await record();

    const said = await db
      .select({ threadId: messages.threadId, parts: messages.parts })
      .from(messages);
    expect(said).toEqual([
      {
        threadId: chat.id,
        parts: [
          expect.objectContaining({
            data: {
              cards: [
                expect.objectContaining({
                  kind: "venue_event",
                  title: 'Fake Market paid out $1 for "Will it rain?"',
                  detail: "The market resolved, and its shares paid $1.",
                }),
              ],
            },
          }),
        ],
      },
    ]);
  });

  it("closes losing shares at nothing", async () => {
    const rain = await insertSpecialist();
    await bought(rain.id, NO, "5", "2.00");
    paying(0n, [{ key: NO, burned: 5_000_000n * SHARE, paidMicros: 0n }]);

    await record();

    const [payout] = await db.select().from(actions).where(eq(actions.tool, TOOL));
    expect(payout?.summary).toBe('Lost on "Will it rain?"');
    expect(await payoutFills()).toEqual([
      expect.objectContaining({
        instrument: NO.instrument,
        quantity: "5.000000000000000000",
        usdValue: "0.00",
      }),
    ]);
  });

  it("closes a bet lost with nothing sent once, tells it in its chat, and Activity says it lost", async () => {
    // Live, 2026-11-16: the 8PM bet's shares lost, were never redeemed, and sat in the
    // portfolio with nothing said (finding 99). The market reads it as lost, with no transaction.
    const chat = await insertThread({ title: "Bitcoin's hour" });
    await bought(null, NO, "1.9607", "1.03", chat.id);
    market.paid = [
      {
        hash: null,
        chain: "polygon",
        markets: [
          {
            question: "Will it rain?",
            paidMicros: 0n,
            shares: [{ key: NO, burned: 1_960_700n * SHARE, paidMicros: 0n }],
          },
        ],
      },
    ];

    await Promise.all([record(), record()]);
    await record();

    const recorded = await db.select().from(actions).where(eq(actions.tool, TOOL));
    expect(recorded).toEqual([
      expect.objectContaining({ status: "done", summary: 'Lost on "Will it rain?"', txs: [] }),
    ]);
    // The books hold none of it now, so nothing reads it again.
    expect(await payoutFills()).toEqual([
      expect.objectContaining({ side: "sell", quantity: "1.960700000000000000", usdValue: "0.00" }),
    ]);
    const asked = market.payouts.mock.calls.length;
    await record();
    expect(market.payouts).toHaveBeenCalledTimes(asked);
    const said = await db
      .select({ threadId: messages.threadId, parts: messages.parts })
      .from(messages);
    expect(said).toEqual([
      {
        threadId: chat.id,
        parts: [
          expect.objectContaining({
            data: {
              cards: [
                expect.objectContaining({
                  title: 'Lost on "Will it rain?"',
                  detail: "The market resolved against these shares, so they paid nothing.",
                }),
              ],
            },
          }),
        ],
      },
    ]);
    const { items } = await readActivity(null);
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "outside",
        title: 'Lost on "Will it rain?"',
        receipt: expect.objectContaining({
          after: "Nothing paid out",
          why: "The market resolved against these shares, so they pay nothing.",
        }),
      }),
    );
  });

  it("shares a payout between whoever held the shares: a specialist, and the loose rest", async () => {
    const rain = await insertSpecialist();
    await bought(rain.id, YES, "6", "3.00");
    await bought(null, YES, "4", "2.00");
    paying(10_000_000n, [{ key: YES, burned: 10_000_000n * SHARE, paidMicros: 10_000_000n }]);

    await record();

    expect(await payoutFills()).toEqual([
      expect.objectContaining({
        specialistId: null,
        quantity: "4.000000000000000000",
        usdValue: "4.00",
      }),
      expect.objectContaining({
        specialistId: rain.id,
        quantity: "6.000000000000000000",
        usdValue: "6.00",
      }),
    ]);
  });

  it("asks nothing of the market while Auni's fills hold none of its shares", async () => {
    await record();
    expect(market.payouts).not.toHaveBeenCalled();
  });

  it("asks only about the outcomes still open, since the first was bought", async () => {
    const rain = await insertSpecialist();
    await bought(rain.id, YES, "10", "6.00");
    await record();
    const [owner, open, since] = market.payouts.mock.calls[0]!;
    expect(owner).toBe(OWNER);
    expect([...open]).toEqual(["polygon:111"]);
    expect(since).toBeGreaterThan(0);
  });
});
