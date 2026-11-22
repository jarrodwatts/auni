import { describe, expect, it } from "vitest";
import { z } from "zod";

import across from "./index.ts";

// Core adds a bridge leg to a card by itself (cash a buy is short of, a holding that pays for
// one) and knows no bridge's field names: the bridge writes its own tool's input for the leg.
describe("Across, as the bridge core's cards pay through", () => {
  const { input, recipe } = across.bridge!;
  const accepted = (leg: Parameters<typeof input>[0]) => z.object(recipe.input).parse(input(leg));

  it("moves cash between the owner's chains", () => {
    expect(accepted({ from: "base", to: "monad", amount: "12.5" })).toEqual({
      from_chain: "base",
      to_chain: "monad",
      amount: "12.5",
    });
  });

  it("sells a token held on another chain as it leaves, by its address", () => {
    const token = "0xd20cd2fa0e9ae2f3f2b8edfbfabaaba6d8ae9bd0";
    expect(accepted({ from: "ethereum", to: "monad", amount: "40", token })).toEqual({
      from_chain: "ethereum",
      to_chain: "monad",
      amount: "40",
      from_token: token,
    });
  });
});
