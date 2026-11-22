import { setTimeout as sleep } from "node:timers/promises";

import { RAW_TRANSACTION_TOOLS } from "@auni/shared";
import { eq, inArray, or, type SQL } from "drizzle-orm";
import { z } from "zod";

import { publishThread } from "../../conversation/threads.ts";
import { db, type Tx } from "../../db/client.ts";
import { actions, specialists, type SpecialistRow } from "../../db/schema.ts";
import { APPROVED_MOVE, APPROVED_MOVE_USD, APPROVED_SALE_OF } from "../approved.ts";
import { fillIdentity, QUANTITY_DECIMALS, type FillKey } from "../fill-key.ts";
import { formatAmount } from "../format.ts";
import { holdingFaces } from "../holdings.ts";
import { rawMoves, settling, tradesHolding } from "../holding-trades.ts";
import { retract } from "../life.ts";
import { readPortfolio, type Holding } from "../portfolio.ts";
import { SETTLING_MS } from "../readings.ts";
import { specialistFills, lockCards, potLeaving } from "../pot.ts";
import { walkPositions, type PotFill } from "../books.ts";
import { tradedToken, type Recipe } from "../recipe.ts";
import { insertFills } from "../record.ts";
import { dollars } from "../summaries.ts";
import { centsToUsd, formatUnits, parseUnits, usdToCents } from "../usd.ts";
import { recipeForTool } from "./index.ts";

/**
 * Re-files a wallet holding between specialists, or between one and Other,
 * without trading it: two fills at the live price, a sale out and a buy in,
 * so totals, costs and returns read it as they read a trade. The pots follow,
 * so neither specialist has more or less of the owner's cash to spend on its own.
 */

const input = {
  chain: z.string().min(1).describe('The holding\'s chain, as get_portfolio names it: "monad".'),
  instrument: z
    .string()
    .min(1)
    .describe("Its instrument, as get_portfolio names it: a token address or mint."),
  from_specialist_id: z
    .uuid()
    .optional()
    .describe("The specialist it's in now; leave out when it's in Other."),
  to_specialist_id: z
    .uuid()
    .optional()
    .describe("The specialist it moves into; leave out to move it out to Other."),
  quantity: z
    .string()
    .regex(/^\d+(\.\d+)?$/u)
    .optional()
    .describe("How much of it, in the units get_portfolio shows; leave out to move all of it."),
};

type MoveInput = z.infer<z.ZodObject<typeof input>>;

/** A holding with a live price, which is what it moves at. */
type Priced = Holding & { readonly usdValue: string };

/** What one move re-files: how much leaves the source's books, how much joins the destination's, and its value. */
interface MovePlan {
  readonly out: bigint;
  readonly in: bigint;
  readonly usdValue: string;
}

/**
 * The move of up to `asked` of a holding, valued at `price`; null when none
 * of it is there. A specialist's books past what it shows (a crumb, or a
 * shortfall the wallet never had) leave with the move, so they keep just what
 * it still shows and can't hide what moved.
 */
export function planMove(input: {
  /** The source's live share of the holding, as the portfolio attributes it. */
  readonly held: Pick<Priced, "quantity">;
  /** What some quantity of it is worth: live on the card, and the card's once allowed. */
  readonly price: Pick<Priced, "quantity" | "usdValue">;
  /** In QUANTITY_DECIMALS units; null for all of it. */
  readonly asked: bigint | null;
  /** A specialist source's net filled quantity; null for Other, which keeps no books of its own. */
  readonly booked: bigint | null;
}): MovePlan | null {
  const held = parseUnits(input.held.quantity, QUANTITY_DECIMALS);
  const moved = input.asked === null || input.asked > held ? held : input.asked;
  if (moved === 0n) return null;
  const priced = parseUnits(input.price.quantity, QUANTITY_DECIMALS);
  const cents = (usdToCents(input.price.usdValue) * moved) / priced;
  const booked = input.booked ?? held;
  return {
    out: booked > held ? booked - (held - moved) : moved,
    in: moved,
    usdValue: centsToUsd(cents),
  };
}

/** The pot of a specialist a holding joins at `usdValue`, which it now holds at that cost. */
function potJoining(potUsd: string, usdValue: string): string {
  return centsToUsd(usdToCents(potUsd) + usdToCents(usdValue));
}

/** The fill of `quantity` of a holding leaving where it was, at `usdValue`; no fee. */
function sale(held: FillKey, quantity: bigint, usdValue: string) {
  return {
    chain: held.chain,
    instrument: held.instrument,
    side: "sell" as const,
    quantity: formatUnits(quantity, QUANTITY_DECIMALS),
    usdValue,
  };
}

/**
 * Waits out a trade of the holding that settled too recently for a read to
 * show, since moves queue on their own; refuses while one still runs, or
 * while they keep coming.
 */
async function settled(holding: FillKey): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    const fresh = await settling(db, holding, Date.now());
    if (fresh.length === 0) return;
    if (fresh.some((row) => row.status === "running")) break;
    const newest = Math.max(...fresh.map((row) => row.updatedAt.getTime()));
    // A second past the window, so the check after the read doesn't find it at the edge.
    await sleep(Math.max(newest + SETTLING_MS - Date.now(), 0) + 1_000);
  }
  throw stillRunning();
}

const stillRunning = () =>
  new Error(
    "Something that may change it is still running, so nothing moved. Try again once it's done.",
  );

/**
 * The plans still waiting that sell this holding, each whole, wherever they
 * wait: a sell of a set amount takes it from the wallet whoever holds it now.
 * A raw transaction is known by what its simulation showed it sending, or goes
 * when it showed nothing to hold it to; a card that names no sale is known by
 * its subject.
 */
async function sellingIt(tx: Tx, holding: FillKey): Promise<SQL> {
  const waiting = await tx.select().from(actions).where(eq(actions.status, "awaiting_permission"));
  const named = fillIdentity(holding);
  const selling = waiting.filter((row) => {
    if (RAW_TRANSACTION_TOOLS.includes(row.tool)) return rawMoves(row, holding, true) !== false;
    return row.details[APPROVED_SALE_OF] === undefined
      ? tradesHolding(row, holding) === true &&
          recipeForTool(row.tool)?.direction?.(row.input as never) === "sell"
      : row.details[APPROVED_SALE_OF] === named;
  });
  return or(
    inArray(
      actions.id,
      selling.map((row) => row.id),
    ),
    inArray(
      actions.proposalId,
      selling.flatMap((row) => (row.proposalId ? [row.proposalId] : [])),
    ),
  )!;
}

/** Where a holding is, by name: a specialist's name, or Other. */
function place(specialist: SpecialistRow | undefined): string {
  return specialist ? specialist.name : "Other";
}

/**
 * What a move is, as its card and its receipt say it. "Other" is the agent's word for what no
 * specialist holds; the owner reads only the specialists the holding joins or leaves.
 */
function moveSummary(
  name: string,
  from: SpecialistRow | undefined,
  to: SpecialistRow | undefined,
): string {
  if (from && to) return `Move your ${name} from ${from.name} to ${to.name}`;
  return to
    ? `Move your ${name} under the ${to.name} specialist`
    : `Move your ${name} out of the ${place(from)} specialist`;
}

/** The specialists a move names, checked as they stand; locked when asked. */
async function places(
  q: Pick<Tx, "select">,
  move: MoveInput,
  lock = false,
): Promise<{ from: SpecialistRow | undefined; to: SpecialistRow | undefined }> {
  const { from_specialist_id: fromId, to_specialist_id: toId } = move;
  if (!fromId && !toId) throw new Error("Name the specialist it moves into or out of.");
  if (fromId === toId) throw new Error("It's already there.");
  const named = q
    .select()
    .from(specialists)
    .where(
      inArray(
        specialists.id,
        [fromId, toId].filter((id) => id !== undefined),
      ),
    )
    .orderBy(specialists.id);
  const rows = lock ? await named.for("update") : await named;
  const from = rows.find((row) => row.id === fromId);
  const to = rows.find((row) => row.id === toId);
  if ((fromId && !from) || (toId && !to)) throw new Error("No such specialist.");
  if (to && to.status !== "active")
    throw new Error(`${to.name} is retired, so nothing can move into it.`);
  return { from, to };
}

/** The holding a move names, as where it is holds it in a fresh read. */
async function heldThere(move: MoveInput): Promise<Priced> {
  const portfolio = await readPortfolio();
  const fromId = move.from_specialist_id;
  const bucket = fromId
    ? portfolio.specialists.find((entry) => entry.id === fromId)
    : portfolio.other;
  const named = fillIdentity({ chain: move.chain, instrument: move.instrument });
  const held = bucket?.holdings.find((holding) => fillIdentity(holding) === named);
  if (!held) {
    const unread =
      portfolio.unavailable.length > 0 ? " (some of their accounts couldn't be read)" : "";
    throw new Error(`It holds none of that there${unread}. Read get_portfolio for what it holds.`);
  }
  if (held.cash)
    throw new Error("Cash isn't moved between specialists: change their pots instead.");
  if (held.venue !== "wallet")
    throw new Error("Only coins and stocks in the wallet can move between specialists.");
  if (held.usdValue === null) throw new Error("It has no live price to move it at right now.");
  return { ...held, usdValue: held.usdValue };
}

/** What a specialist's own fills hold of a holding. */
function bookedOf(recorded: readonly PotFill[], holding: FillKey): bigint {
  return walkPositions(recorded).positions.get(fillIdentity(holding))?.quantity ?? 0n;
}

export const moveHolding: Recipe<typeof input> = {
  tool: "move_holding",
  venue: "ledger",
  // Each weighs what is held where, so two never run at once.
  lane: () => "ledger",
  description:
    "Move something the owner holds into a specialist, out of one to Other, or from one " +
    "specialist to another, without trading it: nothing is sold or bought and no fee is paid, " +
    "only which specialist it counts toward changes. Name it by the chain and instrument " +
    "get_portfolio shows. It moves at the price its card shows: the specialist it joins has its pot raised " +
    "by that much, the one it leaves has its pot lowered so its uninvested money stays the same, " +
    "and from then on it counts toward the new one's returns. Only coins and stocks in the " +
    "wallet can move. It always waits for the owner's tap, and declines any card still waiting " +
    "to sell it.",
  input,
  offChain: true,
  filesUnder: (move) => move.to_specialist_id ?? move.from_specialist_id,
  about: ({ details }) => tradedToken(details, 0),
  async describe(move) {
    const [{ from, to }, held] = await Promise.all([places(db, move), heldThere(move)]);
    const asked = move.quantity === undefined ? null : parseUnits(move.quantity, QUANTITY_DECIMALS);
    if (asked !== null && asked > parseUnits(held.quantity, QUANTITY_DECIMALS))
      throw new Error(`${place(from)} holds only ${held.quantity} of it.`);
    const [faces, recorded] = await Promise.all([
      holdingFaces([held]),
      from ? specialistFills(db, from.id) : [],
    ]);
    const plan = planMove({
      held,
      price: held,
      asked,
      booked: from ? bookedOf(recorded, held) : null,
    });
    if (!plan) throw new Error(`${place(from)} holds none of it.`);
    // Where it counts, and what that specialist's pot becomes.
    const side = (specialist: SpecialistRow | undefined, after: string | undefined) =>
      specialist && after
        ? `${place(specialist)} (pot ${dollars(specialist.potUsd)} to ${dollars(after)})`
        : place(specialist);
    const amount = `${formatAmount(Number(formatUnits(plan.in, QUANTITY_DECIMALS)))} ${held.symbol}`;
    const name = faces[0]?.name ?? held.symbol;
    return {
      summary: moveSummary(name, from, to),
      // It spends none of the owner's cash.
      amountUsd: "0",
      // Nothing leaves the wallet: only which specialist it counts toward changes.
      effect: {
        gives: [
          {
            text: `${amount} from ${side(from, from && potLeaving(from.potUsd, recorded, sale(held, plan.out, plan.usdValue)))}`,
            usd: Number(plan.usdValue),
          },
        ],
        gets: [{ text: `${amount} in ${side(to, to && potJoining(to.potUsd, plan.usdValue))}` }],
        grants: [],
      },
      details: {
        [APPROVED_MOVE]: formatUnits(plan.in, QUANTITY_DECIMALS),
        [APPROVED_MOVE_USD]: plan.usdValue,
        chain: held.chain,
        mint: held.instrument,
        token: held.symbol,
      },
    };
  },
  async execute({ action, input: move }) {
    await settled({ chain: move.chain, instrument: move.instrument } as FillKey);
    const readStarted = Date.now();
    const held = await heldThere(move);
    const approved = parseUnits(action.details[APPROVED_MOVE] ?? "0", QUANTITY_DECIMALS);
    // It moves at the price its card showed, so its fills and pots are what was allowed.
    const price = {
      quantity: action.details[APPROVED_MOVE] ?? "0",
      usdValue: action.details[APPROVED_MOVE_USD] ?? "0",
    };
    // An amount named moves whole or not at all; all of it moves what is there now.
    if (move.quantity !== undefined && parseUnits(held.quantity, QUANTITY_DECIMALS) < approved)
      throw new Error("Less of it is there than the card showed, so nothing moved.");
    const retracted = await db.transaction(async (tx) => {
      // Locked, so the pots change against what they are now and a plan acting on its own waits,
      // and no card is recorded against it until this commits.
      await lockCards(tx);
      const { from, to } = await places(tx, move, true);
      // Taken back first: a sell allowed after this finds it taken back, and one allowed before
      // is running, which the check below refuses.
      const retracted = await retract(tx, await sellingIt(tx, held), "moved");
      if ((await settling(tx, held, readStarted)).length > 0) throw stillRunning();
      const recorded = from ? await specialistFills(tx, from.id) : [];
      const plan = planMove({
        held,
        price,
        asked: approved,
        booked: from ? bookedOf(recorded, held) : null,
      });
      if (!plan) throw new Error(`${place(from)} holds none of it now, so nothing moved.`);
      const out = sale(held, plan.out, plan.usdValue);
      await insertFills(tx, action.id, [
        { ...out, specialistId: from?.id ?? null },
        {
          ...out,
          side: "buy",
          quantity: formatUnits(plan.in, QUANTITY_DECIMALS),
          specialistId: to?.id ?? null,
        },
      ]);
      if (from)
        await tx
          .update(specialists)
          .set({ potUsd: potLeaving(from.potUsd, recorded, out) })
          .where(eq(specialists.id, from.id));
      if (to)
        await tx
          .update(specialists)
          .set({ potUsd: potJoining(to.potUsd, plan.usdValue) })
          .where(eq(specialists.id, to.id));
      return retracted;
    });
    const threads = new Set(retracted.flatMap((row) => row.threadId ?? []));
    await Promise.all([...threads].map(publishThread));
    return { txs: [], fills: [] };
  },
};
