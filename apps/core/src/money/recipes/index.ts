import { fillFace, type ActionCardWire, type FilledFace, type MoneyToolName } from "@auni/shared";

import type { ActionRow } from "../../db/schema.ts";
import { appRecipes, offered } from "../../apps/registry.ts";
import { moneyOf, type Money, type Recipe } from "../recipe.ts";
import { parseUnits } from "../usd.ts";
import { convertToCash } from "./convert.ts";
import { sendEvmTransaction } from "./evm.ts";
import { sendSolanaTransaction } from "./solana.ts";
import { evmSwap } from "../swaps/evm-swap.ts";
import { solanaSwap } from "../swaps/solana-swap.ts";
import { stockTrade } from "./stock-trade.ts";
import { withdrawUsdc } from "./withdraw.ts";

/** A recipe the agent calls as a tool of the same name. */
export type ToolRecipe = Recipe & { readonly tool: MoneyToolName };

/** Auni's own money tools; each venue app brings its own (see appRecipes). */
const CORE_RECIPES: readonly ToolRecipe[] = [
  evmSwap,
  solanaSwap,
  stockTrade,
  sendEvmTransaction,
  sendSolanaTransaction,
  withdrawUsdc,
] as readonly ToolRecipe[];

/**
 * Every money-moving tool the agent can call now: Auni's own, then each app's that the owner
 * has not turned off.
 */
export function recipes(): readonly ToolRecipe[] {
  return [...CORE_RECIPES, ...appRecipes(offered())] as readonly ToolRecipe[];
}

/** Moves only code puts on a card (see pay-with-holdings.ts), never a tool. */
const cardMoves: readonly Recipe[] = [convertToCash] as readonly Recipe[];

/** The recipe behind a tool the agent names, never a move only code puts on a card. */
export function toolRecipe(tool: string): ToolRecipe | undefined {
  return recipes().find((recipe) => recipe.tool === tool);
}

/**
 * Every recipe a recorded action can run: each tool's, whether or not its app is on, and the
 * moves only code puts on a card. Turning an app off never strands a move already allowed, or
 * leaves an old card unreadable.
 */
export function everyRecipe(): readonly Recipe[] {
  return [...CORE_RECIPES, ...appRecipes(), ...cardMoves];
}

/** The recipe a recorded action ran, whoever put it on its card. */
export function recipeForTool(tool: string): Recipe | undefined {
  return everyRecipe().find((recipe) => recipe.tool === tool);
}

type MoneyRow = Pick<ActionRow, "tool" | "input" | "details" | "run" | "amountUsd">;

/**
 * The money a recorded move moves, and which way: cash it readies without
 * selling anything (a bridge, savings back to the wallet) moves rather than
 * goes in.
 */
export function rowMoney(row: MoneyRow): Money | null {
  const money = moneyOf(row);
  return money?.flow === "in" && recipeForTool(row.tool)?.readies?.(row.input as never)
    ? { ...money, flow: "move" }
    : money;
}

/**
 * What each move on one card counts toward its money: with a buy on it, cash
 * readied for the buy is how the buy is paid, not money of its own.
 */
export function cardMoneys(rows: readonly MoneyRow[]): (Money | null)[] {
  const legs = rows.map((row) => {
    const recipe = recipeForTool(row.tool);
    const input = row.input as never;
    return {
      lands: recipe?.readies?.(input) ?? null,
      draws: recipe?.fundedFrom?.({ input, details: row.details }) ?? null,
    };
  });
  const buys = legs.some(({ lands, draws }) => lands === null && draws !== null);
  return rows.map((row, index) => (buys && legs[index]!.lands !== null ? null : rowMoney(row)));
}

/** A move's card face with its own amount in, or null for a move recorded with no face. */
export function filledFace(row: ActionRow): FilledFace | null {
  return row.card ? fillFace(row.card, cardMoney(rowMoney(row)).amount) : null;
}

/** A move's money as its card carries it, which way it goes included; zero for none. */
export function cardMoney(money: Money | null): Pick<ActionCardWire, "amount" | "flow"> {
  return {
    amount: {
      baseUnits: parseUnits(money?.usd ?? "0", 6).toString(),
      currency: { code: "USDC", decimals: 6 },
    },
    flow: money?.flow ?? "in",
  };
}
