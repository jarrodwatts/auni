import { setTimeout as sleep } from "node:timers/promises";

import {
  isAsk,
  isVenueTool,
  knownAsset,
  appListing,
  type MoneyFlow,
  type ActivityItemWire,
  type ActivityStoryWire,
  type ActivityWire,
  type NetworkKey,
  withArticle,
} from "@auni/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { theOwner } from "../auth/owner.ts";
import { db } from "../db/client.ts";
import { actions, arrivals, fills, owner, threads, type ActionRow } from "../db/schema.ts";
import { accounts, ledgerAt } from "../apps/registry.ts";
import { PNL_DECIMALS } from "./books.ts";
import { subjectLogo } from "./action-card.ts";
import { chainLabel, chainName, explorerTx, placeLogo, placeName } from "./chains.ts";
import { coinName } from "./coins.ts";
import { QUANTITY_DECIMALS, tokenKey } from "./fill-key.ts";
import { formatAmount, priceLabel, shortAddress } from "./format.ts";
import { namer, type Namer } from "./holdings.ts";
import { happenedWords, isNews, moved, why } from "./news.ts";
import { TOLD, TOLD_SQL } from "./told.ts";
import { frees, stagedLeg } from "./proposal-order.ts";
import { wrapOf } from "./raw-transaction.ts";
import { moneyOf, subjectOf, type Recipe, type Subject } from "./recipe.ts";
import { convertToCash } from "./recipes/convert.ts";
import { recipeForTool } from "./recipes/index.ts";
import { WITHDRAW_TOOL } from "./withdrawals.ts";
import { filledLater } from "./statements.ts";
import { happenedSchema, orderOf } from "./venue-statement.ts";
import { dollars } from "./summaries.ts";
import {
  centsToUsd,
  formatUnits,
  parseUnits,
  signedUnits,
  signedUsdToCents,
  sumUsd,
  usdToCents,
} from "./usd.ts";

/**
 * A person's activity: what happened to their money, one item per thing they
 * would name. Every leg of one card is one move, its plumbing (cash gathered,
 * moved between wallets or into a venue's account, holdings sold to pay) only the
 * steps of how Auni did it; what a venue did by itself is its own item, as is
 * money that arrived or left without Auni. Every word is code's. What they
 * didn't do themselves is unread until they look (see markActivitySeen).
 */

type Item = ActivityItemWire;
type Amount = NonNullable<Item["amount"]>;
type Logo = NonNullable<Item["logo"]>;
type Story = ActivityStoryWire;
type Step = Extract<Item, { kind: "move" }>["receipt"]["steps"][number];
type ArrivalRow = typeof arrivals.$inferSelect;
type FillRow = Pick<
  typeof fills.$inferSelect,
  | "actionId"
  | "threadId"
  | "instrument"
  | "side"
  | "quantity"
  | "usdValue"
  | "pnlUsd"
  | "venueRef"
  | "createdAt"
>;

/** The most items one read lists, newest first. */
const ITEMS = 200;

/** Logos are decoration: past this an item goes without one. */
const LOGO_WAIT_MS = 1_500;

/** One done leg of a move of Auni's, named, as activity folds it. */
export interface Leg {
  /** Its action's id; for an order of its filling later, that and when. */
  readonly id: string;
  readonly proposalId: string | null;
  readonly threadId: string | null;
  /** Every thread it moved money for: its own, and any its fills went to. */
  readonly touches: readonly string[];
  readonly at: Date;
  readonly does: LegDoes;
  /** What it did, told whole from its record (see storyOf); null where nothing more can be said. */
  readonly story: Story | null;
}

export type LegDoes =
  | {
      /** What the card was for, as its title says it ("Bought" "Pearl"), and its step. */
      readonly kind: "pick";
      readonly verb: string;
      readonly name: string;
      readonly step: string;
      /** What it put in, brought back, or sent out of their account. */
      readonly money: { readonly flow: MoneyFlow | "out"; readonly usd: string } | null;
      readonly logo: Logo | null;
      /** What closing a position locked in, in cents, signed, as its venue said; absent for anything else. */
      readonly made?: bigint;
    }
  | {
      /** Something they held loose, sold to pay for the picks. */
      readonly kind: "sale";
      readonly name: string;
      readonly usd: string;
      readonly logo: Logo | null;
    }
  | {
      /** Cash moved to where the picks spend it. */
      readonly kind: "cash";
      readonly move: CashMove;
      readonly usd: string;
    };

/**
 * Cash out of savings or a venue's account (a perps account, by its place), between the owner's
 * wallets on two networks, or into an account.
 */
type CashMove =
  | { readonly kind: "from_savings" }
  | { readonly kind: "between_wallets"; readonly from: string; readonly to: string }
  | { readonly kind: "from_account" | "to_account"; readonly place: string };

/** Each kind of cash move, in the order they run. */
const CASH_ORDER: readonly CashMove["kind"][] = [
  "from_savings",
  "from_account",
  "between_wallets",
  "to_account",
];

function cashStep(move: CashMove): string {
  switch (move.kind) {
    case "from_savings":
      return "Took cash out of savings";
    case "from_account":
      return `Took cash out of ${placeName(move.place)}`;
    case "between_wallets":
      return `Moved cash from ${placeName(move.from)} to ${placeName(move.to)}`;
    case "to_account":
      return `Moved cash to ${placeName(move.place)}`;
  }
}

/** The mark of where a move of cash went: the account it left or reached, or the wallet it reached. */
function cashLogo(move: CashMove): string | null {
  switch (move.kind) {
    case "from_savings":
      return null;
    case "from_account":
    case "to_account":
      return placeLogo(move.place);
    case "between_wallets":
      return placeLogo(move.to);
  }
}

/** Something a venue did by itself, as its item shows it. */
interface Outside {
  readonly id: string;
  readonly at: Date;
  /** When Auni recorded it, which says whether it's unread. */
  readonly recordedAt: Date;
  readonly threadId: string | null;
  readonly touches: readonly string[];
  readonly title: string;
  readonly amount: Amount | null;
  readonly logo: Logo | null;
  /** Whether it leaves them something to decide, as a liquidation does and a payout doesn't. */
  readonly decision: boolean;
  readonly receipt: Extract<Item, { kind: "outside" }>["receipt"];
}

/** What activity is made of, read and named. */
export interface ActivityFacts {
  readonly legs: readonly Leg[];
  readonly outside: readonly Outside[];
  /** Arrivals told (see told.ts). */
  readonly arrivals: readonly ArrivalRow[];
  /** Each thread's title, by id. */
  readonly threads: ReadonlyMap<string, string>;
  readonly seenAt: Date;
  readonly timeZone: string;
}

/**
 * The person's activity, newest first: everything, or with `only` what one
 * thread took part in; and how many of all of it are unread.
 */
export function activityOf(facts: ActivityFacts, only: string | null): ActivityWire {
  const all = [
    ...moves(facts),
    ...facts.outside.map((one) => outsideItem(one, facts)),
    ...arrivalItems(facts),
  ];
  const items = all
    .filter(({ touches }) => only === null || touches.includes(only))
    .map(({ item }) => item)
    .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, ITEMS);
  return { items, unread: all.filter(({ item }) => item.unread).length };
}

interface Listed {
  readonly item: Item;
  readonly touches: readonly string[];
}

/**
 * Every move of Auni's, one per card: the legs of one proposal folded into
 * one item. A card that only moved their cash, or sold what they held,
 * is named by its first step, since they asked for that itself.
 */
function moves(facts: ActivityFacts): Listed[] {
  const cards = [...Map.groupBy(facts.legs, (leg) => leg.proposalId ?? leg.id)]
    .map(([id, legs]) => ({
      id,
      legs,
      at: new Date(Math.min(...legs.map((leg) => leg.at.getTime()))),
      threadId: legs.find((leg) => leg.threadId)?.threadId ?? null,
      picks: legs.flatMap((leg) => (leg.does.kind === "pick" ? [leg.does] : [])),
    }))
    .toSorted((a, b) => a.at.getTime() - b.at.getTime());
  return cards.map((card) => {
    const name = card.threadId ? facts.threads.get(card.threadId) : undefined;
    const steps = stepsOf(card.legs);
    const only = card.picks.length === 0 ? steps[0] : undefined;
    return {
      touches: [...new Set(card.legs.flatMap((leg) => leg.touches))],
      item: {
        kind: "move",
        id: card.id,
        title: only?.text ?? titleOf(card.picks),
        subtitle: `${name?.trim() || "Auni"}, ${when(card.at, facts.timeZone)}`,
        category: card.picks.some((pick) => pick.money?.flow === "out") ? "transfer" : "trade",
        amount: only
          ? only.amountUsd
            ? { usd: only.amountUsd, direction: null, tone: "neutral" }
            : null
          : (madeAmount(card.picks) ?? moveAmount(card.picks)),
        threadId: card.threadId as Item["threadId"],
        logo: only ? saleLogo(card.legs) : (card.picks.find((pick) => pick.logo)?.logo ?? null),
        at: card.at.toISOString(),
        unread: false,
        receipt: { steps, story: card.legs.length === 1 ? card.legs[0]!.story : null },
      },
    };
  });
}

/** What a card that bought nothing wears: the one thing it sold, else nothing (Auni's own mark). */
function saleLogo(legs: readonly Leg[]): Logo | null {
  const sales = legs.flatMap(({ does }) => (does.kind === "sale" ? [does] : []));
  return sales.length === 1 ? sales[0]!.logo : null;
}

/** "Bought Pearl", "Closed Meta, bought Micron", "Bought Pearl and 3 more". */
export function titleOf(
  picks: readonly Pick<Extract<LegDoes, { kind: "pick" }>, "verb" | "name">[],
): string {
  return [...Map.groupBy(picks, (pick) => pick.verb)]
    .map(([verb, same], index) => {
      const names = [...new Set(same.map((pick) => pick.name))];
      const named =
        names.length <= 2 ? names.join(" and ") : `${names[0]} and ${names.length - 1} more`;
      const phrase = `${verb} ${named}`.trim();
      return index === 0 ? phrase : phrase.charAt(0).toLowerCase() + phrase.slice(1);
    })
    .join(", ");
}

/** What closing positions locked in, signed: a card of closes only, each one's result known. */
function madeAmount(picks: readonly Extract<LegDoes, { kind: "pick" }>[]): Amount | null {
  if (picks.length === 0 || picks.some((pick) => pick.made === undefined)) return null;
  return resultAmount(picks.reduce((sum, pick) => sum + pick.made!, 0n));
}

/** A result locked in, as a row's amount: a gain in, a loss out, nothing plain. */
function resultAmount(cents: bigint): Amount {
  const usd = centsToUsd(cents < 0n ? -cents : cents);
  if (cents === 0n) return { usd, direction: null, tone: "neutral" };
  return cents < 0n
    ? { usd, direction: "out", tone: "loss" }
    : { usd, direction: "in", tone: "gain" };
}

/**
 * What a move put in, plain, as a buy is; else what it moved between their
 * own accounts, plain; else what it sent out of their account, signed; else
 * what its sales brought back, plain.
 */
function moveAmount(picks: readonly Extract<LegDoes, { kind: "pick" }>[]): Amount | null {
  for (const flow of ["in", "move", "out", "back"] as const) {
    const usd = sumUsd(
      picks.flatMap((pick) => (pick.money?.flow === flow ? [pick.money.usd] : [])),
    );
    if (usd !== "0.00") return { usd, direction: flow === "out" ? "out" : null, tone: "neutral" };
  }
  return null;
}

/**
 * How Auni did it, in the order it ran, in at most four lines: what it sold
 * of theirs, the cash it moved (a move between wallets said by the move into
 * a venue's account it was for), then each pick.
 */
export function stepsOf(legs: readonly Leg[]): Step[] {
  const sales = legs.flatMap((leg) => (leg.does.kind === "sale" ? [leg.does] : []));
  const moves = legs.flatMap(({ does }) => (does.kind === "cash" ? [does] : []));
  const intoAccount = moves.some(({ move }) => move.kind === "to_account");
  const cash = new Map<string, { usd: string[]; logoUrl: string | null }>();
  for (const kind of CASH_ORDER)
    for (const { move, usd } of moves) {
      if (move.kind !== kind || (kind === "between_wallets" && intoAccount)) continue;
      const step = cashStep(move);
      cash.set(step, { usd: [...(cash.get(step)?.usd ?? []), usd], logoUrl: cashLogo(move) });
    }
  const steps: Step[] = [
    ...(sales.length === 0
      ? []
      : [
          {
            text:
              sales.length === 1 ? `Sold ${sales[0]!.name}` : `Sold ${sales.length} other holdings`,
            amountUsd: sumUsd(sales.map((sale) => sale.usd)),
            logoUrl: sales.length === 1 ? (sales[0]!.logo?.src ?? null) : null,
          },
        ]),
    ...[...cash].map(([text, { usd, logoUrl }]) => ({ text, amountUsd: sumUsd(usd), logoUrl })),
    ...legs.flatMap(({ does }) =>
      does.kind === "pick"
        ? [{ text: does.step, amountUsd: does.money?.usd ?? null, logoUrl: does.logo?.src ?? null }]
        : [],
    ),
  ];
  if (steps.length <= 4) return steps;
  const rest = steps.slice(3);
  const amounts = rest.flatMap((step) => step.amountUsd ?? []);
  return [
    ...steps.slice(0, 3),
    {
      text: `${rest.length} more moves`,
      amountUsd: amounts.length > 0 ? sumUsd(amounts) : null,
      logoUrl: null,
    },
  ];
}

function outsideItem(one: Outside, facts: ActivityFacts): Listed {
  const name = one.threadId ? facts.threads.get(one.threadId) : undefined;
  return {
    touches: one.touches,
    item: {
      kind: "outside",
      id: one.id,
      // A venue closing a position or paying out a market is a trade's end, whatever it made.
      category: "trade",
      title: one.title,
      subtitle: [...(name?.trim() ? [name.trim()] : []), when(one.at, facts.timeZone)].join(", "),
      amount: one.amount,
      threadId: one.threadId as Item["threadId"],
      logo: one.logo,
      at: one.at.toISOString(),
      unread: one.recordedAt > facts.seenAt,
      decision: one.decision,
      receipt: one.receipt,
    },
  };
}

/** Money that arrived or left without Auni, one item per transaction each way. */
function arrivalItems(facts: ActivityFacts): Listed[] {
  const byMove = Map.groupBy(
    facts.arrivals,
    (row) => `${row.chain}:${row.txHash}:${row.kind === "external_out" ? "out" : "in"}`,
  );
  return [...byMove.values()].map((rows) => {
    const [first] = rows as [ArrivalRow];
    const out = first.kind === "external_out";
    const cents = rows.reduce((sum, row) => {
      const each = signedUsdToCents(row.usdValue!);
      return sum + (each < 0n ? -each : each);
    }, 0n);
    const counterparties = new Set(rows.map((row) => row.counterparty));
    const [counterparty] = counterparties.size === 1 ? [...counterparties] : [null];
    const goods = moved(rows);
    // Pictured by the registry's name alone: a token of theirs may call itself USDC.
    const coin = coinName(first);
    return {
      touches: [],
      item: {
        kind: "arrival",
        id: first.id,
        category: "transfer",
        title: out ? "Money left your wallet" : "Money arrived",
        subtitle: `Your wallet, ${when(first.at, facts.timeZone)}`,
        amount: {
          usd: centsToUsd(cents),
          direction: out ? "out" : "in",
          tone: out ? "neutral" : "gain",
        },
        threadId: null,
        logo: {
          src: coin === null ? null : (knownAsset(coin)?.logoUrl ?? null),
          name: goods[0]?.symbol.slice(0, 60) || "a token",
        },
        at: first.at.toISOString(),
        // A first sweep's history, which they knew of, is never unread (see isNews).
        unread: rows.some((row) => isNews(row) && row.createdAt > facts.seenAt),
        receipt: {
          network: chainName(first.chain as NetworkKey),
          moved: goods.map(({ amount, symbol }) => ({ amount, symbol })),
          counterparty: counterparty ? shortAddress(counterparty) : null,
        },
      },
    };
  });
}

/** "Oct 14 at 8:21pm" in their time zone, with its year when not this one: "Oct 14, 2025 at 8:21pm". */
export function when(at: Date, timeZone: string): string {
  const year = (date: Date) => date.toLocaleString("en-US", { timeZone, year: "numeric" });
  const day = at.toLocaleString("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    ...(year(at) === year(new Date()) ? {} : { year: "numeric" }),
  });
  const time = at
    .toLocaleString("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
    .replace(/\s([AP])M$/u, (_, half: string) => `${half.toLowerCase()}m`);
  return `${day} at ${time}`;
}

/** The person's activity, read now (see activityOf). */
export async function readActivity(only: string | null): Promise<ActivityWire> {
  const done = eq(actions.status, "done");
  const [rows, recorded, arrived, named, names] = await Promise.all([
    // In the order they were made, so a card's picks are said in its order.
    db.select().from(actions).where(done).orderBy(asc(actions.createdAt)),
    db
      .select({
        actionId: fills.actionId,
        threadId: fills.threadId,
        instrument: fills.instrument,
        side: fills.side,
        quantity: fills.quantity,
        usdValue: fills.usdValue,
        pnlUsd: fills.pnlUsd,
        venueRef: fills.venueRef,
        createdAt: fills.createdAt,
      })
      .from(fills)
      .innerJoin(actions, eq(actions.id, fills.actionId))
      .where(done),
    db
      .select()
      .from(arrivals)
      .where(and(inArray(arrivals.kind, [...TOLD]), TOLD_SQL)),
    db.select({ id: threads.id, title: threads.title }).from(threads),
    namer(),
  ]);
  const { activitySeenAt, timeZone } = await theOwner();
  const fillsOf = Map.groupBy(recorded, (fill) => fill.actionId);
  const own = (row: ActionRow) => fillsOf.get(row.id) ?? [];
  // An ask changed Auni, not money: it stays in its thread, as the card the owner allowed.
  const legs = await Promise.all(
    rows
      .filter((row) => !isVenueTool(row.tool) && !isAsk(row.tool))
      .map((row) => legsOf(row, own(row), names)),
  );
  const payoutTools = new Set<string>(
    accounts().flatMap(({ account }) => (account.payouts ? [account.payouts.tool] : [])),
  );
  const outside = await Promise.all(
    rows
      .filter((row) => isVenueTool(row.tool))
      .map((row) =>
        payoutTools.has(row.tool) ? payoutOf(row, own(row)) : venueFillOf(row, own(row), names),
      ),
  );
  return activityOf(
    {
      legs: legs.flat(),
      outside,
      arrivals: arrived,
      threads: new Map(
        named.flatMap(({ id, title }) => (title?.trim() ? [[id, title.trim()] as const] : [])),
      ),
      seenAt: activitySeenAt,
      timeZone,
    },
    only,
  );
}

/** Everything they have is seen, as of now. */
export async function markActivitySeen(): Promise<void> {
  await db.update(owner).set({ activitySeenAt: sql`now()` });
}

/**
 * A done move of Auni's as its legs: the move, and each later fill of an
 * order it left behind (a stop, a resting limit), by when it filled.
 * Lateness goes by when the venue filled it, as the chat's news does.
 */
async function legsOf(row: ActionRow, own: readonly FillRow[], names: Namer): Promise<Leg[]> {
  const at = row.startedAt ?? row.createdAt;
  const late = (fill: FillRow) => fill.venueRef !== null && filledLater(row, fill.createdAt);
  const prompt = own.filter((fill) => !late(fill));
  const move: Leg = {
    id: row.id,
    proposalId: row.proposalId,
    threadId: row.threadId,
    touches: touchesOf(row.threadId, prompt),
    at,
    does: await readLeg(row, names, prompt),
    story: storyOf(row, prompt),
  };
  const later = Map.groupBy(own.filter(late), (fill) => fill.createdAt.getTime());
  return [
    move,
    ...(await Promise.all([...later].map(([time, filled]) => laterFill(row, time, filled, names)))),
  ];
}

/**
 * What a recorded move did, read through today's recipe. History outlives
 * what Auni offers (a network it has since dropped), so a move today's recipe
 * can't read shows as it was told then, and is reported, rather than taking
 * the rest of activity down with it.
 */
async function readLeg(
  row: ActionRow,
  names: Namer,
  filled: readonly FillRow[],
): Promise<LegDoes> {
  const recipe = recipeForTool(row.tool);
  try {
    return await doesOf(row, recipe, recipe ? subjectOf(recipe, row) : null, names, filled);
  } catch (error) {
    console.error(`action ${row.id} can't be read by today's recipe`, error);
    return doesOf(row, undefined, null, names, filled);
  }
}

/**
 * What one move did, told from its record (see ActivityStoryWire): a trade by what it filled, a
 * position by what it opened or closed and the prices around it, cash moved by where it left and
 * landed, and any move by the services it went through and where its transactions can be seen.
 * Null where the record holds none of that, or where today's recipe can't read it (see readLeg),
 * whose title says it as it was told then.
 */
function storyOf(row: ActionRow, filled: readonly FillRow[]): Story | null {
  let read: { subject: Subject | null; staged: ReturnType<typeof stagedLeg> };
  try {
    const recipe = recipeForTool(row.tool);
    read = { subject: recipe ? subjectOf(recipe, row) : null, staged: stagedLeg(row) };
  } catch {
    return null;
  }
  const told =
    read.subject?.kind === "perp"
      ? positionTold(read.subject, filled, moneyOf(row)?.usd ?? null)
      : sidesOf(row, filled, read.subject, read.staged);
  const through =
    row.run.through ?? row.details.through ?? (row.venue && appListing(row.venue)?.name) ?? null;
  return told || through ? storyWith(told, through, linksOf(row, read.staged.lands)) : null;
}

/** What a move did, told, with the services it went through and where to see it; null with none of that. */
function storyWith(told: Told | null, through: string | null, links: Story["links"]): Story | null {
  const facts = [
    ...(told?.facts ?? []),
    ...(through ? [{ label: "Through", value: through }] : []),
  ];
  if (!told?.gave && !told?.got && !told?.levels.length && facts.length === 0 && !links.length)
    return null;
  return {
    gave: told?.gave ?? null,
    got: told?.got ?? null,
    levels: told?.levels ?? [],
    facts,
    links,
  };
}

/** What a move did, before the services it went through and where to see it. */
type Told = Pick<Story, "gave" | "got" | "levels" | "facts">;
type Side = NonNullable<Story["gave"]>;
type Level = Story["levels"][number];

const side = (label: string, value: string, place: string | null = null): Side => ({
  label,
  value,
  place,
  tone: "neutral",
});

/** What a move gave and got, and at what price, as its record holds them; null where it doesn't. */
function sidesOf(
  row: ActionRow,
  filled: readonly FillRow[],
  subject: Subject | null,
  { draws, lands }: Pick<ReturnType<typeof stagedLeg>, "draws" | "lands">,
): Told | null {
  if (subject?.kind === "token") {
    const fill = filled.find(
      (each) => each.instrument.toLowerCase() === subject.mint.toLowerCase(),
    );
    const quantity = Number(fill?.quantity);
    if (!fill || !(quantity > 0)) return null;
    const unit = subject.stock ? "shares" : (subject.symbol ?? "tokens");
    const place = chainLabel(subject.chain);
    const tokens = `${formatAmount(quantity)} ${unit}`;
    const cash = dollars(fill.usdValue);
    const each = Number(fill.usdValue) / quantity;
    const facts = [
      { label: "Price", value: `${priceLabel(each)} per ${subject.stock ? "share" : unit}` },
    ];
    return fill.side === "buy"
      ? {
          gave: side("You paid", row.details.sell ?? cash, place),
          got: side("You got", tokens, place),
          levels: [],
          facts,
        }
      : {
          gave: side("You sold", tokens, place),
          got: side("You got", cash, place),
          levels: [],
          facts,
        };
  }
  if (lands === null || moneyOf(row)?.flow === "back") return null;
  // Where it landed and what, as its run wrote it ("$0.99 on Polygon"), else as its card said.
  const landed = row.run.lands?.match(/^(.+) on (.+)$/u);
  return {
    gave: side("Sent", dollars(row.amountUsd), draws ? placeName(draws) : null),
    got: landed
      ? side("Arrived", landed[1]!, landed[2]!)
      : side("Arrived", dollars(row.amountUsd), placeName(lands)),
    levels: [],
    facts: [],
  };
}

/**
 * What a move did to a leveraged position, from its fills and what its recipe says of it: what
 * it opened and with how much, or what it closed and what that made or lost, with the prices it
 * entered and closed at; or the stops it set, beside the market's price then. A number the
 * record doesn't hold is left out.
 */
function positionTold(
  perp: Extract<Subject, { kind: "perp" }>,
  filled: readonly FillRow[],
  margin: string | null,
): Told {
  const levels = [
    ...(perp.closes?.entryUsd ? [level("Entered at", perp.closes.entryUsd, "price")] : []),
    ...(!perp.opens && !perp.closes && perp.markUsd
      ? [level("Price then", perp.markUsd, "price")]
      : []),
    ...(["stopLoss", "takeProfit"] as const).flatMap((kind) => {
      const price = perp.stops?.[kind];
      return typeof price === "number" ? [level(STOP_NAMES[kind], price, "stop")] : [];
    }),
  ];
  const traded = perp.opens
    ? tradedPosition(perp.opens, { opened: margin }, filled)
    : tradedPosition(perp.closes ?? null, "closed", filled);
  return {
    gave: traded?.gave ?? null,
    got: traded?.got ?? null,
    levels: byPrice([...levels, ...(traded ? [traded.level] : [])]),
    facts: (["stopLoss", "takeProfit"] as const).flatMap((kind) =>
      perp.stops?.[kind] === null ? [{ label: STOP_NAMES[kind], value: "Removed" }] : [],
    ),
  };
}

const STOP_NAMES = { stopLoss: "Stop-loss", takeProfit: "Take-profit" } as const;

/** A price on the story's line of prices, with the number it sorts by. */
type Priced = Level & { readonly at: number };

function level(label: string, price: number, kind: Level["kind"]): Priced {
  return { label, price: priceLabel(price), kind, at: price };
}

/** Prices highest first, as a chart would stack them. */
function byPrice(levels: readonly Priced[]): Level[] {
  return levels
    .toSorted((a, b) => b.at - a.at)
    .map(({ label, price, kind }) => ({ label, price, kind }));
}

/**
 * What fills of a position did, as their tiles say it: the margin it put in ("You put in") for
 * the position it opened ("Your 2x short", its size), or the position it closed and what that
 * made or lost, by what the venue said each fill locked in; and the price it filled at. Null with
 * no fills.
 */
function tradedPosition(
  position: { readonly side: "long" | "short"; readonly leverage?: number } | null,
  did: { readonly opened: string | null } | "closed",
  filled: readonly FillRow[],
): { gave: Side | null; got: Side | null; level: Priced } | null {
  const quantity = filled.reduce(
    (sum, fill) => sum + parseUnits(fill.quantity, QUANTITY_DECIMALS),
    0n,
  );
  if (!position || quantity === 0n) return null;
  const notional = usdToCents(sumUsd(filled.map((fill) => fill.usdValue)));
  const price = Number(centsToUsd(notional)) / Number(formatUnits(quantity, QUANTITY_DECIMALS));
  const named = `Your ${position.leverage ? `${position.leverage}x ` : ""}${position.side}`;
  const size = dollars(centsToUsd(notional));
  if (did !== "closed")
    return {
      gave: did.opened === null ? null : side("You put in", dollars(did.opened)),
      got: side(named, size),
      level: level("Entered at", price, "price"),
    };
  const { made } = madeBy(filled);
  return {
    gave: side(named, size),
    got:
      made === undefined
        ? null
        : {
            ...side(
              made < 0n ? "Realized loss" : "Realized profit",
              dollars(centsToUsd(made < 0n ? -made : made)),
            ),
            tone: made < 0n ? "loss" : made > 0n ? "gain" : "neutral",
          },
    level: level("Closed at", price, "price"),
  };
}

/**
 * What the venue said fills closing a position locked in, to the nearest cent; nothing when it
 * said nothing of one of them, or there are none.
 */
function madeBy(filled: readonly FillRow[]): { made?: bigint } {
  if (filled.length === 0 || filled.some((fill) => fill.pnlUsd === null)) return {};
  const fine = filled.reduce((sum, fill) => sum + signedUnits(fill.pnlUsd!, PNL_DECIMALS), 0n);
  const half = 10n ** BigInt(PNL_DECIMALS - 2) / 2n;
  const step = 10n ** BigInt(PNL_DECIMALS - 2);
  return { made: (fine + (fine < 0n ? -half : half)) / step };
}

/**
 * Where a move's transactions can be seen: each it sent on a chain with an explorer, but the
 * groundwork (an approval, the coin bought for its fee), and the one that delivered it where it
 * `lands`.
 */
function linksOf(row: ActionRow, lands: string | null): Story["links"] {
  const seen = [
    ...row.txs.flatMap(({ chain, hash, setup, buysFees }) =>
      hash && !setup && !buysFees ? [{ chain, hash, verb: "See it" }] : [],
    ),
    ...(row.run.delivered && lands
      ? [{ chain: lands, hash: row.run.delivered, verb: "See it arrive" }]
      : []),
  ];
  return seen
    .flatMap(({ chain, hash, verb }) => {
      const explorer = explorerTx(chain, hash);
      return explorer ? [{ label: `${verb} on ${explorer.name}`, url: explorer.url }] : [];
    })
    .slice(0, 4);
}

/** What one leg of a move did, as its card would name it, by what it `filled` as it ran. */
async function doesOf(
  row: ActionRow,
  recipe: Recipe | undefined,
  subject: Subject | null,
  names: Namer,
  filled: readonly FillRow[],
): Promise<LegDoes> {
  const money = moneyOf(row);
  if (!recipe)
    return { kind: "pick", verb: "", name: row.summary, step: row.summary, money, logo: null };
  const { lands, draws } = stagedLeg(row);
  if (lands !== null) {
    // A conversion, or a token sold home through a bridge, sells what they held loose.
    if (row.tool === convertToCash.tool || money?.flow === "back") {
      const name = await nameOf(subject, row.venue, names);
      return {
        kind: "sale",
        name,
        usd: money?.usd ?? row.amountUsd,
        logo: await logoOf(subject, row.venue, name),
      };
    }
    const move: CashMove = ledgerAt(lands)
      ? { kind: "to_account", place: lands }
      : !frees({ draws, lands })
        ? { kind: "between_wallets", from: draws!, to: lands }
        : draws && ledgerAt(draws)
          ? { kind: "from_account", place: draws }
          : { kind: "from_savings" };
    return { kind: "cash", move, usd: row.amountUsd };
  }
  // An outcome is named by its market, as its card's row is (see CardFace.pick).
  const name =
    subject?.kind === "outcome" && row.card?.pick
      ? `“${row.card.pick.name}”`
      : await nameOf(subject, row.venue, names);
  const logo = await logoOf(subject, row.venue, name);
  const pick = (verb: string, step: string, flow: MoneyFlow | "out" | undefined = money?.flow) => ({
    kind: "pick" as const,
    verb,
    name,
    step,
    money: money && flow ? { flow, usd: money.usd } : null,
    logo,
  });
  switch (subject?.kind) {
    case "perp":
      // An order that filled nothing as it was placed rests as a limit: what fills later says it opened.
      if (subject.opens && filled.length === 0)
        return {
          ...pick(
            "Placed an order for",
            `Placed an order to open ${name}, ${subject.opens.leverage}x ${subject.opens.side}`,
          ),
          money: null,
        };
      // A position is opened and closed, never bought: "Opened an ETH long", "Closed your BTC long".
      if (subject.opens)
        return {
          ...pick("Opened", `Opened ${name}, ${subject.opens.leverage}x ${subject.opens.side}`),
          name: withArticle(`${name} ${subject.opens.side}`),
        };
      if (subject.closes)
        return {
          ...pick(
            closed(subject.closes.all),
            `Closed ${subject.closes.all ? "" : "part of "}${name}, ${subject.closes.leverage}x ${subject.closes.side}`,
          ),
          name: `${name} ${subject.closes.side}`,
          ...madeBy(filled),
        };
      return { ...pick("Set stops on", `Set stops on ${name}`), money: null };
    case "cash":
      return row.tool === WITHDRAW_TOOL
        ? { ...pick("Withdrew", "Sent to your address", "out"), name: dollars(row.amountUsd) }
        : {
            ...pick("Saved", "Put into savings"),
            name: dollars(row.amountUsd),
            // Savings wear the mark of the app that keeps them.
            logo: row.venue
              ? { src: appListing(row.venue)?.logo ?? null, name: venueName(row) }
              : null,
          };
    case "app":
      return pick("Used", row.summary);
    case "token":
    case "outcome": {
      // Wrapping a coin moves it between its two forms: neither a buy nor a sale.
      const wrap = wrapOf(row);
      if (wrap) {
        const [verb, from, into] = wrap.wraps
          ? ["Wrapped", wrap.symbol, `W${wrap.symbol}`]
          : ["Unwrapped", `W${wrap.symbol}`, wrap.symbol];
        return { ...pick(verb, `${verb} ${from} into ${into}`, "move"), name: from };
      }
      const verb = money?.flow === "back" ? "Sold" : "Bought";
      return pick(verb, `${verb} ${name}`);
    }
    default:
      return { ...pick("", row.summary), name: row.summary };
  }
}

/** What closing a position did, before its name: "Closed your" BTC long, or part of it. */
function closed(all: boolean): string {
  return `Closed ${all ? "" : "part of "}your`;
}

/** The leveraged position a recorded move opens, as its recipe says; undefined for one that opens none. */
function opened(row: ActionRow) {
  const recipe = recipeForTool(row.tool);
  const subject = recipe ? subjectOf(recipe, row) : null;
  return subject?.kind === "perp" ? subject.opens : undefined;
}

/**
 * A fill of an order a move left behind, later than the move (see orderOf):
 * its resting limit filling, which puts in the margin it was placed with, or
 * a stop-loss or take-profit closing what it opened, told by what the venue
 * said it locked in.
 */
async function laterFill(
  row: ActionRow,
  time: number,
  filled: readonly FillRow[],
  names: Namer,
): Promise<Leg> {
  const face = await names.perp(row.venue!, filled[0]!.instrument);
  const { side } = filled[0]!;
  const opens = opened(row);
  const order = orderOf(opens?.side ?? null, side);
  // An exit sells a long and buys back a short.
  const held = opens?.side ?? ((side === "buy") === (order !== "exit") ? "long" : "short");
  const position = `${face.name} ${held}`;
  const notional = usdToCents(sumUsd(filled.map((fill) => fill.usdValue)));
  const margin = order === "limit" && opens ? centsToUsd(notional / BigInt(opens.leverage)) : null;
  const traded = tradedPosition(
    { side: held, leverage: opens?.leverage },
    order === "exit" ? "closed" : { opened: margin },
    filled,
  );
  return {
    id: `${row.id}:${time}`,
    proposalId: null,
    threadId: row.threadId,
    touches: touchesOf(row.threadId, filled),
    at: new Date(time),
    does: {
      kind: "pick",
      verb: order === "exit" ? closed(true) : "Opened",
      name: order === "exit" ? position : withArticle(position),
      step: why(order, venueName(row)),
      money: margin === null ? null : { flow: "in", usd: margin },
      logo: { src: face.logoUrl, name: face.name },
      ...(order === "exit" ? madeBy(filled) : {}),
    },
    story: storyWith(
      traded && { gave: traded.gave, got: traded.got, levels: [traded.level], facts: [] },
      venueName(row),
      [],
    ),
  };
}

/** A venue's name, by the app id a row names it by. */
function venueName(row: ActionRow): string {
  return (row.venue && appListing(row.venue)?.name) ?? "The venue";
}

/** A trade no order of Auni's made at a perps venue, in the venue's own numbers. */
async function venueFillOf(
  row: ActionRow,
  own: readonly FillRow[],
  names: Namer,
): Promise<Outside> {
  const happened = happenedSchema.parse(row.details);
  const face = await names.perp(row.venue!, happened.market);
  const pnl = Number(happened.closedPnlUsd);
  const words = happenedWords(happened, face, venueName(row), pnl);
  const cents = usdToCents(Math.abs(pnl).toFixed(2));
  return {
    ...outsideOf(row, own),
    title: words.title,
    amount: cents === 0n ? null : resultAmount(pnl < 0 ? -cents : cents),
    logo: { src: face.logoUrl, name: face.name },
    // The venue acting on a position, or someone trading it elsewhere: theirs to decide about.
    decision: true,
    receipt: {
      by: venueName(row),
      before: words.before,
      after: words.after,
      why: words.why,
    },
  };
}

/** A prediction market paying out a resolved market, at what it paid for the shares. */
function payoutOf(row: ActionRow, own: readonly FillRow[]): Outside {
  const by = venueName(row);
  const paid = sumUsd(own.map((fill) => fill.usdValue));
  const shares = own.reduce((sum, fill) => sum + parseUnits(fill.quantity, QUANTITY_DECIMALS), 0n);
  const any = paid !== "0.00";
  return {
    ...outsideOf(row, own),
    title: row.summary,
    amount: any ? { usd: paid, direction: "in", tone: "gain" } : null,
    logo: { src: (row.venue && appListing(row.venue)?.logo) || null, name: by },
    decision: false,
    receipt: {
      by,
      before: `${formatAmount(Number(formatUnits(shares, QUANTITY_DECIMALS)))} shares`,
      after: any ? `${dollars(paid)} paid out` : "Nothing paid out",
      why: any
        ? `The market resolved, so ${by} paid out its shares by itself.`
        : "The market resolved against these shares, so they pay nothing.",
    },
  };
}

/** Whose something a venue did is: the thread that held most of it, or none. */
function outsideOf(row: ActionRow, own: readonly FillRow[]) {
  const held = new Map<string | null, bigint>();
  for (const fill of own)
    held.set(
      fill.threadId,
      (held.get(fill.threadId) ?? 0n) + parseUnits(fill.quantity, QUANTITY_DECIMALS),
    );
  const [main] = [...held].toSorted((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0));
  return {
    id: row.id,
    at: row.createdAt,
    // Recorded done, and never changed since.
    recordedAt: row.updatedAt,
    threadId: main?.[0] ?? null,
    touches: touchesOf(null, own),
  };
}

function touchesOf(threadId: string | null, own: readonly FillRow[]): string[] {
  return [
    ...new Set([threadId, ...own.map((fill) => fill.threadId)].filter((id) => id !== null)),
  ];
}

/** What a move at `venue` (an app id) is about, as the portfolio names it. */
async function nameOf(
  subject: Subject | null,
  venue: string | null,
  names: Namer,
): Promise<string> {
  switch (subject?.kind) {
    case "perp":
      return (await names.perp(venue!, subject.market)).name;
    case "token":
      return (
        (await names.token(tokenKey(subject.chain, subject.mint))) ?? subject.symbol ?? "a token"
      );
    case "outcome":
      return subject.outcome ? `${subject.outcome} shares` : "prediction shares";
    case "app":
      return subject.name;
    default:
      return "cash";
  }
}

/**
 * What a leg about `subject` wears: its picture, named so the web can show the initials of what
 * it is (`name` where the picture names nothing) without one; with neither a picture nor
 * something it is about (cash, savings), null, and the row wears Auni's own mark.
 */
async function logoOf(
  subject: Subject | null,
  venue: string | null,
  name: string,
): Promise<Logo | null> {
  const logo = await Promise.race([
    subjectLogo(subject, venue).catch(() => null),
    sleep(LOGO_WAIT_MS, null),
  ]);
  const src = logo?.src ?? null;
  const about = subject !== null && subject.kind !== "cash";
  return src || about ? { src, name: (logo?.name ?? name).slice(0, 60) } : null;
}
