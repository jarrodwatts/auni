import {
  AMOUNT,
  appListing,
  fillFace,
  listed,
  type ActionCardWire,
  type actionCardSchema,
  type CardFace,
  type PlanMove,
} from "@auni/shared";
import type { z } from "zod";

import { APPROVED_PRICE_AT_LEAST, APPROVED_PRICE_AT_MOST, APPROVED_PROCEEDS } from "./approved.ts";
import { isSavings, ledgerAt, appById } from "../apps/registry.ts";
import type { ActionRow } from "../db/schema.ts";
import { fitted, LINE_MOST, plainFace, warnedFirst } from "./card-face.ts";
import { LINES } from "./effect.ts";
import { feeCoinsSaid } from "./fee-coin-said.ts";
import { lostSaid } from "./gone-for-good.ts";
import { placeName } from "./chains.ts";
import { tokenKey } from "./fill-key.ts";
import { withdrawalFeeUsd } from "./funding.ts";
import { LOGOS, perpFace, tokenArt, tokenCalled } from "./holdings.ts";
import { stagedLeg } from "./proposal-order.ts";
import { subjectOf, type Money, type Recipe, type Subject } from "./recipe.ts";
import { recipeForTool, rowMoney } from "./recipes/index.ts";
import { dollars } from "./summaries.ts";
import { parseUnits } from "./usd.ts";
import { stepUpSays } from "./step-up.ts";

type CardVenue = ActionCardWire["venue"];

/**
 * The mark a money card carries: its app's own where the move is filed under an app that has
 * one, else the mark the move's recipe names, else Auni's.
 */
export function cardVenue(venue: string | null, recipe?: Pick<Recipe, "mark">): CardVenue {
  if (venue && appById(venue)?.about.mark) return venue as CardVenue;
  return recipe?.mark ?? "auni";
}

/**
 * How a move reads as one row of a plan, under its name: its face's own line (where it goes or
 * runs), else what it gets and where it lands, from its lines; null for neither. One short line
 * for every recipe, whether or not it wrote a face, and never its figures run together.
 */
export function rowLine(
  face: Pick<CardFace, "context">,
  lines: readonly { readonly label: string; readonly value: string }[],
): string | null {
  if (face.context) return face.context;
  const gets = lines.find(({ label }) => label === LINES.gets)?.value;
  return gets ? gets.charAt(0).toUpperCase() + gets.slice(1) : null;
}

/** A plan's move as its button is named from: its face's button, and its money. */
interface PlanButtonLeg extends Pick<ActionCardWire, "amount" | "flow"> {
  readonly card: Pick<CardFace, "action">;
  /** Whether it moves the owner's own cash between their places: out of savings, a bridge. */
  readonly movesCash: boolean;
}

/**
 * The button of a plan, named for what the whole card does. A lone move, whose other moves only
 * bring its cash, reads as its own button ("Long BTC"); moves that all do one thing read as that
 * ("Buy both for {amount}", "Close all 3"); a mix says each thing it does ("Move and sell"), and
 * past three, how many moves it makes. Cash moved between the owner's own places is one thing,
 * moving, whether it comes out of savings or crosses a bridge. `AMOUNT` stands for the money the
 * card shows at its head, and several moves say it only where each puts money in, so it is
 * always money that leaves, never what a sale brings back.
 */
export function planAction(legs: readonly PlanButtonLeg[]): string {
  if (legs.length === 1) return legs[0]!.card.action;
  const verbs = [
    ...new Set(legs.map(({ card, movesCash }) => (movesCash ? "Move" : verbOf(card.action)))),
  ];
  if (verbs.length === 1) {
    const all = `${verbs[0]} ${legs.length === 2 ? "both" : `all ${legs.length}`}`;
    const spends = legs.every(({ flow, amount }) => flow === "in" && amount.baseUnits !== "0");
    return spends ? `${all} for ${AMOUNT}` : all;
  }
  if (verbs.length > 3) return `Make ${legs.length} moves`;
  return listed(
    verbs.map((verb, index) => (index === 0 ? verb : verb.charAt(0).toLowerCase() + verb.slice(1))),
  );
}

/**
 * The verb of a face's button, which is a verb and what it acts on: the words before the amount
 * ("Take out {amount}"), else the first ("Sell Nvidia", "Close long").
 */
function verbOf(action: string): string {
  const before = action.split(AMOUNT)[0]!.trim();
  return action.includes(AMOUNT) && before ? before : (action.split(" ")[0] ?? action);
}

/** What a trade's card pins of its price, which a run of it is held to however late it goes. */
const PRICED = [APPROVED_PROCEEDS, APPROVED_PRICE_AT_MOST, APPROVED_PRICE_AT_LEAST];

/**
 * What a card of several moves says, before the tap, of the trades on it that wait for its money
 * moves to land: each is priced again when its turn comes, minutes on, and goes only inside what
 * the card shows (see quoteHoldingProceeds and approvedPrice), so one whose market moved past
 * that by then doesn't go. Null when no priced trade waits.
 */
export function pricedLater(rows: readonly ActionRow[]): string | null {
  const staged = rows.map(stagedLeg);
  const first = Math.min(...staged.map(({ stage }) => stage));
  const waiting = rows.filter(
    ({ details }, index) =>
      staged[index]!.stage > first &&
      staged[index]!.lands === null &&
      PRICED.some((key) => details[key] !== undefined),
  );
  if (waiting.length === 0) return null;
  const names = listed(
    waiting.map((row) =>
      row.card ? fillFace(row.card, cardMoney(rowMoney(row)).amount).title : row.summary,
    ),
  );
  return waiting.length === 1
    ? `${names} waits for the moves before it to land and is priced again then. If its price has moved past what this card allows, it doesn't go, and Auni tells you.`
    : `${names} wait for the moves before them to land and are priced again then. Any whose price has moved past what this card allows doesn't go, and Auni tells you.`;
}

/**
 * The moves that get cash to where a card's picks spend it, in the order they
 * run, so the first that failed is the one that stopped the rest.
 */
export function moveCards(rows: readonly ActionRow[]): PlanMove[] {
  return rows.toSorted((a, b) => stagedLeg(a).stage - stagedLeg(b).stage).map(moveCard);
}

/**
 * A move in code's own plain words, never dressed as a pick: "Move $3.73 from Base to Solana".
 */
function moveCard(row: ActionRow): PlanMove {
  const { draws, lands } = stagedLeg(row);
  const amount = dollars(row.amountUsd);
  const lets = row.lines.find(({ label }) => label === LINES.lets)?.value.slice(0, LINE_MOST);
  const [name, from] = fromSavings(row)
    ? [`Take ${amount} out of savings`, "your savings"]
    : row.tool === "convert_to_cash"
      ? [
          `Convert ${row.details.sell} on ${placeName(lands!)} to USDC`,
          `your ${placeName(lands!)} wallet`,
        ]
      : // A sale that readies cash (a token sold home through a bridge) says what it sells.
        row.details.returnsUsd
        ? [row.summary, null]
        : draws && ledgerAt(draws)
          ? [
              `Take ${amount} out of ${placeName(draws)}, which keeps $${withdrawalFeeUsd(draws)}`,
              placeName(draws),
            ]
          : // A token bridged in spends no cash of its own, so there's no wallet of cash to name.
            [
              `Move ${amount}${draws ? ` from ${placeName(draws)}` : ""} to ${placeName(lands!)}`,
              draws && `your ${placeName(draws)} wallet`,
            ];
  return {
    actionReference: row.id as PlanMove["actionReference"],
    name,
    ...(from ? { from } : {}),
    ...(lands ? { lands } : {}),
    status: row.status,
    // Whatever it leaves able to act on the money, which one Allow grants with the rest.
    ...(lets ? { lets } : {}),
  };
}

/** Whether a move readies cash out of savings: its subject is cash at a savings venue. */
function fromSavings(row: ActionRow): boolean {
  const recipe = recipeForTool(row.tool);
  const subject = recipe && subjectOf(recipe, row);
  return subject?.kind === "cash" && isSavings(subject.at);
}

/** A move's money as its card carries it, which way it goes included; zero for none. */
function cardMoney(money: Money | null): Pick<ActionCardWire, "amount" | "flow"> {
  return {
    amount: {
      baseUnits: parseUnits(money?.usd ?? "0", 6).toString(),
      currency: { code: "USDC", decimals: 6 },
    },
    flow: money?.flow ?? "in",
  };
}

/** A move's picture, and what it shows by name, for a card to draw its initials without one. */
interface SubjectLogo {
  readonly src: string | null;
  readonly name: string | null;
}

/** The picture a move at `venue` (its recipe's) wears, from what the move is about. */
export async function subjectLogo(
  subject: Subject | null,
  venue: string | null,
): Promise<SubjectLogo> {
  switch (subject?.kind) {
    case "token": {
      const [src, called] = await Promise.all([
        tokenArt(subject.chain, subject.mint),
        tokenCalled(tokenKey(subject.chain, subject.mint)),
      ]);
      // A token's symbol is its maker's, at any length; a card takes up to 40 characters.
      return { src, name: called ?? (subject.symbol?.trim().slice(0, 40) || null) };
    }
    case "perp": {
      const face = await perpFace(venue!, subject.market);
      return { src: face.logoUrl, name: face.ticker };
    }
    case "outcome":
      return { src: subject.image ?? (venue && appListing(venue)?.logo) ?? null, name: null };
    case "cash":
      // Cash going to or from a venue wears that venue's mark, which the web draws on its own
      // tile, so it sends none; cash between the owner's wallets wears USDC's.
      return subject.at === "wallet"
        ? { src: LOGOS.usdc, name: "USDC" }
        : { src: null, name: null };
    case "app":
      return { src: subject.logo, name: subject.name };
    default:
      return { src: null, name: null };
  }
}

/**
 * A face that also says, first among its warnings, where the move sends money nobody could ever
 * spend (see gone-for-good.ts), from where its action pinned money leaving and the tokens its card
 * showed it sending. Whoever wrote the face, it can't leave that out.
 */
function withLoss(row: Pick<ActionRow, "details">, face: CardFace): CardFace {
  const lost = lostSaid(row);
  if (!lost) return face;
  return { ...face, warning: warnedFirst(lost, face.warning) };
}

/** The web's `action` card for one money action. */
export async function actionCard(
  row: ActionRow,
  recipe: Recipe,
): Promise<z.input<typeof actionCardSchema>> {
  const logo = await subjectLogo(subjectOf(recipe, row), recipe.venue);
  const proofWhy = row.status === "awaiting_permission" ? await stepUpSays(row) : null;
  const buysFirst = feeCoinsSaid([row]);
  // What the card says of the move, cut to the lengths a card takes.
  const said = {
    summary: row.summary.slice(0, 500),
    lines: row.lines.map(({ label, value }) => ({
      label: label.slice(0, 60),
      value: value.slice(0, LINE_MOST),
    })),
    details: Object.fromEntries(
      Object.entries(row.details).map(([key, value]) => [
        key.slice(0, 60),
        String(value).slice(0, 500),
      ]),
    ),
    ...cardMoney(rowMoney(row)),
  };
  return {
    id: row.id,
    kind: "action",
    title: row.summary.slice(0, 160),
    updatedAt: row.updatedAt.toISOString(),
    actionReference: row.id,
    tool: recipe.tool,
    venue: cardVenue(row.venue, recipe),
    logoUrl: logo.src,
    logoName: logo.name,
    ...said,
    // The move's own face, or the plain one of a move that wrote none, from the card as it
    // stands; and whoever wrote it, what the card spends on coin for its fees (see
    // feeCoinsSaid) and where nobody could ever spend what it sends (see withLoss).
    card: withLoss(row, {
      ...(row.card ?? fitted(plainFace(said, row.run.lands))),
      ...(buysFirst && { buysFirst }),
    }),
    ...(proofWhy ? { takesProof: true, proofWhy } : {}),
    status: row.status,
    error: row.error?.slice(0, 500) ?? null,
  };
}
