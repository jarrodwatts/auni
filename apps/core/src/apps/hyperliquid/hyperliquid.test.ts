import { describe, expect, it } from "vitest";

import { walletsFor } from "../../test/wallets.ts";
import type { Market } from "./markets.ts";
import { formatPrice, formatSize } from "./markets.ts";
import { liquidationMove } from "./order.ts";
import {
  assertStopsBracket,
  entryWire,
  orderAction,
  orderTag,
  sizeFor,
  stopLegs,
  stopTagsFrom,
  taggedAction,
} from "./orders.ts";
import {
  actionHash,
  l1TypedData,
  signTypedData,
  userSignedTypedData,
  WITHDRAW_FIELDS,
} from "./signing.ts";

/** The official Python SDK's test key (hyperliquid-python-sdk tests/signing_test.py). */
const SDK_KEY = "0x0123456789012345678901234567890123456789012345678901234567890123";

/** An action's id, as its orders are tagged with it. */
const ACTION = "5f0c2a8e-1b7d-4c3a-9e2f-0a1b2c3d4e5f";

const XYZ_TSLA: Market = {
  name: "xyz:TSLA",
  dex: "xyz",
  assetId: 110_001,
  szDecimals: 3,
  maxLeverage: 20,
  markPx: 330,
  dayVolumeUsd: 0,
  fundingRate: 0,
  collateralToken: 0,
};

describe("L1 action signing", () => {
  it("matches the production connectionId vector", () => {
    const action = {
      type: "order",
      orders: [{ a: 4, b: true, p: "1670.1", s: "0.0147", r: false, t: { limit: { tif: "Ioc" } } }],
      grouping: "na",
    };
    expect(actionHash(action, 1_677_777_606_040)).toBe(
      "0x0fcbeda5ae3c4950a548021552a4fea2226858c4453571bf3f24ba017eac2908",
    );
  });

  it("reproduces the official SDK order and trigger-order signatures", async () => {
    const wallets = walletsFor(SDK_KEY);
    const order = {
      type: "order",
      orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }],
      grouping: "na",
    };
    expect(await signTypedData(wallets, l1TypedData(order, 0))).toEqual({
      r: "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e",
      s: "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e",
      v: 28,
    });
    const trigger = {
      type: "order",
      orders: [
        {
          a: 1,
          b: true,
          p: "100",
          s: "100",
          r: false,
          t: { trigger: { isMarket: true, triggerPx: "103", tpsl: "sl" } },
        },
      ],
      grouping: "na",
    };
    expect(await signTypedData(wallets, l1TypedData(trigger, 0))).toEqual({
      r: "0x98343f2b5ae8e26bb2587daad3863bc70d8792b09af1841b6fdd530a2065a3f9",
      s: "0x6b5bb6bb0633b710aa22b721dd9dee6d083646a5f8e581a20b545be6c1feb405",
      v: 27,
    });
    // A tagged order, its tag after its type (test_l1_action_signing_order_with_cloid_matches).
    const tagged = {
      ...order,
      orders: [{ ...order.orders[0]!, c: "0x00000000000000000000000000000001" }],
    };
    expect(await signTypedData(wallets, l1TypedData(tagged, 0))).toEqual({
      r: "0x041ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3",
      s: "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da",
      v: 27,
    });
  });

  it("refuses a signature that does not recover to the owner's wallet", async () => {
    const wallets = walletsFor(SDK_KEY, "0x1111111111111111111111111111111111111111");
    await expect(signTypedData(wallets, l1TypedData({ type: "noop" }, 1))).rejects.toThrow(
      "did not recover",
    );
  });
});

describe("user-signed actions", () => {
  it("reproduces the official SDK withdraw signature", async () => {
    const typedData = userSignedTypedData("HyperliquidTransaction:Withdraw", WITHDRAW_FIELDS, {
      type: "withdraw3",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a",
      amount: "1",
      time: 1_687_816_341_423,
    });
    expect(await signTypedData(walletsFor(SDK_KEY), typedData)).toEqual({
      r: "0x8363524c799e90ce9bc41022f7c39b4e9bdba786e5f9c72b20e43e1462c37cf9",
      s: "0x58b1411a775938b83e29182e8ef74975f9054c8e97ebf5ec2dc8d51bfc893881",
      v: 28,
    });
  });
});

describe("order wire", () => {
  it("builds the xyz:TSLA order the venue filled in the funded drill", () => {
    const action = orderAction(
      [
        entryWire({
          market: XYZ_TSLA,
          isBuy: true,
          price: formatPrice(330.02 * 1.02, XYZ_TSLA.szDecimals, "nearest"),
          size: formatSize(12 / 330.02, XYZ_TSLA.szDecimals),
          reduceOnly: false,
          tif: "Ioc",
        }),
      ],
      "na",
      ACTION,
    );
    expect(action).toEqual({
      type: "order",
      orders: [
        {
          a: 110_001,
          b: true,
          p: "336.62",
          s: "0.036",
          r: false,
          t: { limit: { tif: "Ioc" } },
          c: "0x5f0c2a8e1b7d4c3a9e2f0a1b2c3d4e00",
        },
      ],
      grouping: "na",
    });
    // Hyperliquid hashes the keys in order: the tag goes last.
    expect(JSON.stringify(action)).toBe(
      '{"type":"order","orders":[{"a":110001,"b":true,"p":"336.62","s":"0.036","r":false,"t":{"limit":{"tif":"Ioc"}},"c":"0x5f0c2a8e1b7d4c3a9e2f0a1b2c3d4e00"}],"grouping":"na"}',
    );
  });

  it("tags each of an action's orders apart, every tag naming the action", () => {
    const later = orderAction(
      stopLegs(XYZ_TSLA, true, { stopLoss: 300 }),
      "positionTpsl",
      ACTION,
      3,
    );
    expect(later.orders[0]?.c).toBe("0x5f0c2a8e1b7d4c3a9e2f0a1b2c3d4e03");
    // A cloid as Hyperliquid's fills carry it back: 16 bytes of hex.
    expect(orderTag(ACTION, 0)).toMatch(/^0x[0-9a-f]{32}$/u);
    expect(taggedAction(orderTag(ACTION, 0))).toBe(taggedAction(orderTag(ACTION, 255)));
    expect(taggedAction(orderTag(ACTION, 0))).toBe(ACTION.replaceAll("-", "").slice(0, 30));
    // An entry's tag is kept for life; each attempt's two stops come after it, never shared.
    expect([1, 2, 3].map((attempt) => stopTagsFrom(attempt, 1))).toEqual([1, 3, 5]);
    expect([1, 2, 3].map((attempt) => stopTagsFrom(attempt, 0))).toEqual([0, 2, 4]);
  });

  // Size "0" is the whole position, whatever it is when the stop fires (see stops.ts).
  it("builds a position's stops as reduce-only trigger orders for all of it, on the closing side", () => {
    const legs = stopLegs(XYZ_TSLA, true, { stopLoss: 300, takeProfit: 400 });
    expect(legs).toEqual([
      {
        a: 110_001,
        b: false,
        p: "270",
        s: "0",
        r: true,
        t: { trigger: { isMarket: true, triggerPx: "300", tpsl: "sl" } },
      },
      {
        a: 110_001,
        b: false,
        p: "360",
        s: "0",
        r: true,
        t: { trigger: { isMarket: true, triggerPx: "400", tpsl: "tp" } },
      },
    ]);
    const short = stopLegs(XYZ_TSLA, false, { stopLoss: 360 });
    expect(short[0]).toMatchObject({
      b: true,
      p: "396",
      t: { trigger: { triggerPx: "360", tpsl: "sl" } },
    });
  });

  it("refuses stops that would fire immediately", () => {
    expect(() => assertStopsBracket(true, 330, { stopLoss: 340 })).toThrow("below 330");
    expect(() => assertStopsBracket(false, 330, { takeProfit: 340 })).toThrow("below 330");
    expect(() => assertStopsBracket(true, 330, { stopLoss: 300, takeProfit: 400 })).not.toThrow();
  });
});

describe("price and size grammar", () => {
  it("keeps five significant figures and at most 6 - szDecimals decimals", () => {
    expect(formatPrice(336.6204, 3, "nearest")).toBe("336.62");
    expect(formatPrice(336.62, 3, "down")).toBe("336.62");
    expect(formatPrice(336.629, 3, "down")).toBe("336.62");
    expect(formatPrice(336.621, 3, "up")).toBe("336.63");
    expect(formatPrice(30_604.01, 4, "nearest")).toBe("30604");
    expect(formatPrice(123_456.7, 5, "nearest")).toBe("123457");
    expect(formatPrice(0.0012345, 0, "nearest")).toBe("0.001235");
    expect(formatPrice(0.0012345, 2, "down")).toBe("0.0012");
    expect(formatPrice(1.5, 1, "nearest")).toBe("1.5");
  });

  it("rounds sizes down onto the lot", () => {
    expect(formatSize(0.0369, 3)).toBe("0.036");
    expect(formatSize(12 / 3, 0)).toBe("4");
    expect(formatSize(0.1 + 0.2, 1)).toBe("0.3");
  });

  it("rounds a $10 order up rather than under the venue minimum", () => {
    // Flooring $10 of BTC at $82,948 onto 5 decimals gives 0.00012, worth $9.95.
    const btc = { ...XYZ_TSLA, name: "BTC", szDecimals: 5 };
    expect(sizeFor(btc, 10, 82_948)).toBe("0.00013");
    // A short's limit sits below the mark; the minimum must hold there too.
    expect(Number(sizeFor(btc, 10, 82_948, 82_948 * 0.99)) * 82_948 * 0.99).toBeGreaterThanOrEqual(
      10,
    );
    expect(sizeFor(btc, 50, 82_948)).toBe("0.0006");
    expect(() => sizeFor(btc, 5, 82_948)).toThrow("no order worth less than $10");
  });
});

describe("liquidation", () => {
  it("leaves a position its margin less the maintenance margin to move against it", () => {
    // 3x on a 40x market: a third of the price, less the 1.25% maintenance.
    expect(liquidationMove(true, 3, 40)).toBeCloseTo(0.3249, 4);
    expect(liquidationMove(false, 3, 40)).toBeCloseTo(0.3169, 4);
    // At the market's max leverage, half its margin is all the room there is.
    expect(liquidationMove(true, 40, 40)).toBeCloseTo(1 / 79, 6);
  });
});
