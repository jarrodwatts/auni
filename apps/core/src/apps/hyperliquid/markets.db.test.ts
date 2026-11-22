import { beforeEach, describe, expect, it } from "vitest";

import { insertAction, wipe } from "../../test/db.ts";
import { tradedMarkets } from "./markets.ts";

beforeEach(() => wipe());

const hyperliquid = (market: string, startedAt: Date | null = new Date()) => ({
  venue: "hyperliquid",
  tool: "hyperliquid_order",
  details: { market },
  startedAt,
});

describe("tradedMarkets", () => {
  it("names each market a Hyperliquid move started on, filled or resting, once", async () => {
    await insertAction({ ...hyperliquid("xyz:NVDA"), status: "done" });
    // A resting limit records no fill, but its position may open later.
    await insertAction({ ...hyperliquid("flx:GOLD"), status: "done" });
    await insertAction({ ...hyperliquid("xyz:NVDA"), tool: "hyperliquid_close" });
    // Never started, so it put nothing anywhere.
    await insertAction({ ...hyperliquid("km:OIL", null), status: "awaiting_permission" });
    // A withdrawal names no market.
    await insertAction({ venue: "hyperliquid", startedAt: new Date() });

    expect((await tradedMarkets()).sort()).toEqual(["flx:GOLD", "xyz:NVDA"]);
  });
});
