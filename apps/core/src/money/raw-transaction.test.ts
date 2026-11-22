import { describe, expect, it } from "vitest";

import { evmTokenKey } from "./fill-key.ts";
import { rawSale } from "./raw-transaction.ts";

const NVDA = "0x1111111111111111111111111111111111111111";
const TSLA = "0x2222222222222222222222222222222222222222";
const USDC = "0x3333333333333333333333333333333333333333";
const names = new Map([
  [NVDA, { symbol: "NVDAx", decimals: 18 }],
  [TSLA, { symbol: "TSLAx", decimals: 18 }],
  [USDC, { symbol: "USDC", decimals: 6 }],
]);
const cash = (token: string) => token === USDC;
const keyOf = (token: string) => evmTokenKey("base", token);
const leg = (token: string, amount: bigint) => ({ token, amount });

describe("rawSale", () => {
  it("names the one holding a transaction lets go of, for dollars or another token", () => {
    const sale = { chain: "base", instrument: NVDA, quantity: "2" };
    const forCash = { out: [leg(NVDA, 2n * 10n ** 18n)], in: [leg(USDC, 400n * 10n ** 6n)] };
    const forToken = { out: [leg(NVDA, 2n * 10n ** 18n)], in: [leg(TSLA, 10n ** 18n)] };
    expect(rawSale(forCash, names, cash, keyOf)).toEqual(sale);
    expect(rawSale(forToken, names, cash, keyOf)).toEqual(sale);
  });

  it("names none for a buy, a batch sending more than one holding, or one with no simulation", () => {
    const buy = { out: [leg(USDC, 400n * 10n ** 6n)], in: [leg(NVDA, 2n * 10n ** 18n)] };
    const batch = { out: [leg(NVDA, 1n), leg(TSLA, 1n)], in: [] };
    expect(rawSale(buy, names, cash, keyOf)).toBeUndefined();
    expect(rawSale(batch, names, cash, keyOf)).toBeUndefined();
    expect(rawSale(null, names, cash, keyOf)).toBeUndefined();
  });
});
