import { describe, expect, it } from "vitest";

import type { ActionRow } from "../../db/schema.ts";
import { cardMoneys, rowMoney } from "./index.ts";

const row = (
  tool: string,
  input: Record<string, unknown>,
  amountUsd: string,
  details: Record<string, string> = {},
) => ({ tool, input, amountUsd, details, run: {} }) as ActionRow;
const bridge = (from: string, to: string, usd: string) =>
  row("bridge_usdc", { from_chain: from, to_chain: to, amount: usd }, usd);

describe("rowMoney", () => {
  it("says cash carried between their own wallets moves, neither going in nor coming back", () => {
    expect(rowMoney(bridge("solana", "monad", "36.55"))).toEqual({ flow: "move", usd: "36.55" });
  });

  it("keeps a bridge that buys a token on arrival going in, and a token sold home coming back", () => {
    const buys = { from_chain: "base", to_chain: "monad", amount: "5", output_token: "0x1" };
    expect(rowMoney(row("bridge_usdc", buys, "5"))?.flow).toBe("in");
    const sells = { from_chain: "1", from_token: "0x07", to_chain: "monad", amount: "1" };
    expect(rowMoney(row("bridge_usdc", sells, "1.88", { returnsUsd: "1.91" }))?.flow).toBe("back");
  });
});

describe("rowMoney floors", () => {
  const sale = (note: string, run: ActionRow["run"] = {}) =>
    ({
      ...row("polymarket_order", {}, "0", { returnsUsd: "191.68" }),
      card: { note },
      run,
    }) as ActionRow;

  it("keeps a sale's floor with its card's condition until it has come back", () => {
    expect(rowMoney(sale("at least, if all 310 sell"))).toEqual({
      flow: "back",
      usd: "191.68",
      least: "if all 310 sell",
    });
    expect(rowMoney(sale("at least"))?.least).toBe("");
    expect(rowMoney(sale("about"))?.least).toBeUndefined();
    expect(rowMoney(sale("at least, if all 310 sell", { returnedUsd: "200.10" }))).toEqual({
      flow: "back",
      usd: "200.10",
    });
  });
});

describe("cardMoneys", () => {
  it("counts a buy's money once, as the buy, never again as the move that pays for it", () => {
    const buy = row("polymarket_order", { side: "buy", amountUsd: 20 }, "20");
    expect(cardMoneys([bridge("base", "polygon", "20"), buy])).toEqual([
      null,
      { flow: "in", usd: "20" },
    ]);
  });

  it("keeps each move's own money on a card with no buy", () => {
    const savings = row("aave_withdraw", { chain: "arbitrum", amount_usd: "100" }, "100");
    const deposit = row("hyperliquid_deposit", { amountUsd: 20 }, "20");
    expect(cardMoneys([savings, deposit])).toEqual([
      { flow: "move", usd: "100" },
      { flow: "move", usd: "20" },
    ]);
  });
});
