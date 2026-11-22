import { AMOUNT, type CardFace } from "@auni/shared";
import { z } from "zod";

import type { Recipe } from "../money/recipe.ts";

/**
 * A stand-in buy that no venue backs: a test overrides what it reads (what `describe` returns,
 * what `execute` does) and anything left as it is throws if it is ever called.
 */
export function stubRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    tool: "stock_trade",
    description: "Buys a stock.",
    venue: "test",
    input: { usd: z.string().optional() },
    direction: () => "buy",
    about: () => null,
    describe: async () => {
      throw new Error("stubRecipe: not stubbed");
    },
    execute: async () => {
      throw new Error("stubRecipe: not stubbed");
    },
    ...overrides,
  };
}

/** What a preview's face says under `label`; undefined when it has no such figure. */
export function figureOf(preview: { readonly card?: CardFace }, label: string): string | undefined {
  return preview.card?.figures.find((figure) => figure.label === label)?.value;
}

/** A face a move might write for its card, for tests of what a card's words are bound to. */
export const FACE: CardFace = {
  title: `Buy Nvidia for ${AMOUNT}`,
  action: `Buy ${AMOUNT}`,
  working: "Buying Nvidia",
  context: "Tokenized stock",
  figures: [{ label: "You pay", value: AMOUNT }],
  finePrint: null,
  receipt: { title: "Bought Nvidia", detail: null, amount: "spent" },
};
