import type { AppJob, AppWire } from "@auni/shared";
import { expect, it } from "vitest";

import { byJob } from "./runs-on";

const app = (id: string, jobs: readonly AppJob[], canSwitch = false): AppWire => ({
  id,
  name: id,
  does: null,
  canSwitch,
  on: true,
  jobs: [...jobs],
  inUse: true,
  standing: null,
  needs: [],
  pairing: null,
  troubles: [],
  settings: [],
  account: null,
  stays: null,
});

// Behind the scenes listed LI.FI twice, under "Trades through" and "Prices tokens with" (2026-11-25).
it("lists each service once, under its first job, naming the others it does", () => {
  const groups = byJob([
    app("lifi", ["trades", "prices"]),
    app("kyber", ["trades"]),
    app("coingecko", ["prices"]),
    app("polymarket", ["trades"], true),
  ]);
  expect(groups.map(({ job, apps }) => [job, apps.map(({ id }) => id)])).toEqual([
    ["trades", ["kyber", "lifi"]],
    ["prices", ["coingecko"]],
  ]);
  expect(groups[0]!.also).toEqual({ kyber: [], lifi: ["prices"] });
});
