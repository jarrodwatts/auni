import { beforeEach, describe, expect, it, vi } from "vitest";

import { readAccount, splitAccount } from "./account.ts";
import { info } from "./api.ts";
import { tradedMarkets } from "./markets.ts";

const USER = "0x3a01d0be0cf4978b652889c44f34b059be0658db";

// Hyperliquid's perps dexes as it lists them, the main one first; an account with nothing anywhere.
vi.mock(import("./api.ts"), async (original) => ({
  ...(await original()),
  info: vi.fn(async (body: { readonly type: string }) => {
    if (body.type === "perpDexs") return [null, { name: "xyz" }, { name: "flx" }, { name: "km" }];
    if (body.type === "userAbstraction") return "unifiedAccount";
    if (body.type === "spotClearinghouseState") return { balances: [] };
    return { withdrawable: "0.0", marginSummary: { accountValue: "0.0" }, assetPositions: [] };
  }) as never,
}));

let traded: string[] = [];
vi.mock(import("./markets.ts"), async (original) => ({
  ...(await original()),
  tradedMarkets: vi.fn(async () => traded),
}));

beforeEach(() => {
  vi.mocked(info).mockClear();
});

/** What each read asked Hyperliquid for: spot, then each perps dex by name ("" is the main one). */
const asked = () =>
  vi
    .mocked(info)
    .mock.calls.map(([body]) => body)
    .filter((body) => body.type !== "perpDexs" && body.type !== "userAbstraction")
    .map((body) => (body.type === "spotClearinghouseState" ? "spot" : String(body.dex ?? "")));

const position = (coin: string, szi: string, marginUsed: string, type = "isolated") => ({
  position: {
    coin,
    szi,
    marginUsed,
    entryPx: null,
    liquidationPx: null,
    unrealizedPnl: "0.0",
    leverage: { type: type as "isolated" | "cross", value: 3 },
  },
});

const dex = (
  withdrawable: string,
  accountValue = withdrawable,
  positions = [position("BTC", "0", "0")],
) => ({
  withdrawable,
  marginSummary: { accountValue },
  assetPositions: positions,
});

const spot = (total: string, hold: string) => ({ balances: [{ coin: "USDC", total, hold }] });

/** A standard account, whose spot and each perps dex keep their own USDC. */
const standard = (balances: ReturnType<typeof spot>, dexes: ReturnType<typeof dex>[]) => ({
  spot: balances,
  dexes,
  pooled: false,
});

const cents = ({ free, onOrders, positions }: ReturnType<typeof splitAccount>) => ({
  free: free / 10_000n,
  onOrders: onOrders / 10_000n,
  positions: positions.map(({ position, micros }) => [position.coin, micros / 10_000n]),
});

// A unified account's states are tested as Hyperliquid answered them, in holdings.test.ts.
describe("splitAccount, for a standard account", () => {
  it("adds its pockets before rounding, so $4.975 and $5.827 free make $10.80", () => {
    expect(cents(splitAccount(standard({ balances: [] }, [dex("4.975"), dex("5.827")]))).free).toBe(
      1_080n,
    );
  });

  it("counts a pocket below zero as nothing rather than taking it from the others", () => {
    const split = splitAccount(standard(spot("1.00", "2.00"), [dex("-3.5"), dex("2.019")]));
    expect(cents(split).free).toBe(201n);
    expect(splitAccount(standard({ balances: [] }, [])).free).toBe(0n);
  });

  it("values an isolated position at its margin, and a cross one at its share of the rest", () => {
    const split = splitAccount(
      standard({ balances: [] }, [
        dex("14.00", "50.00", [
          position("xyz:META", "0.09", "20"),
          position("xyz:TSLA", "-1", "10", "cross"),
          position("xyz:NVDA", "2", "6", "cross"),
        ]),
      ]),
    );
    expect(cents(split)).toEqual({
      free: 1_400n,
      onOrders: 0n,
      positions: [
        ["xyz:META", 2_000n],
        ["xyz:TSLA", 1_000n],
        ["xyz:NVDA", 600n],
      ],
    });
  });

  it("keeps what a dex holds beside its isolated positions as held for orders", () => {
    expect(cents(splitAccount(standard({ balances: [] }, [dex("8.00", "8.50")])))).toEqual({
      free: 800n,
      onOrders: 50n,
      positions: [],
    });
    const split = splitAccount(
      standard(spot("5.00", "1.25"), [dex("1.00", "4.00", [position("BTC", "0.0001", "2.10")])]),
    );
    expect(cents(split)).toEqual({ free: 475n, onOrders: 215n, positions: [["BTC", 210n]] });
  });
});

describe("readAccount", () => {
  it("reads the main dex and each dex Auni traded on, never the rest", async () => {
    traded = ["xyz:NVDA", "BTC", "xyz:TSLA", "flx:GOLD"];
    const account = await readAccount(USER);
    expect(asked()).toEqual(["spot", "", "xyz", "flx"]);
    expect(account.dexes).toHaveLength(3);
    expect(tradedMarkets).toHaveBeenCalled();
  });

  it("reads only the main dex, where deposits land, for someone Auni never traded perps for", async () => {
    traded = [];
    await readAccount(USER);
    expect(asked()).toEqual(["spot", ""]);
  });

  it("skips the dex of a traded market Hyperliquid no longer lists, which it would refuse", async () => {
    traded = ["gone:FOO"];
    await readAccount(USER);
    expect(asked()).toEqual(["spot", ""]);
  });
});
