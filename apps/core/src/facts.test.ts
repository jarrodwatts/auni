import { afterEach, describe, expect, it, vi } from "vitest";

import { FACT_WAIT_MS, appFacts } from "./facts.ts";
import type { AppFact, OwnerSeen } from "./apps/contract.ts";

const seen: OwnerSeen = {
  holdings: [{ symbol: "ETH", name: "Ethereum", usdValue: "80.00", image: null }],
};

const fact = (text: string): AppFact => ({
  text,
  label: text,
  link: null,
  image: "https://app.hyperliquid.xyz/coins/ETH.svg",
  starts: [{ statement: text, action: "Tell me", prompt: `Tell me about ${text}.` }],
});

function source(id: string, facts: (seen: OwnerSeen, signal: AbortSignal) => Promise<AppFact[]>) {
  return { about: { id, name: id }, facts };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("appFacts", () => {
  it("cites each fact as the app's own, whatever the app says it is", async () => {
    const posing = { ...fact("A planted fact"), source: { app: "auni", label: "Your money" } };
    const facts = await appFacts(seen, [source("polymarket", async () => [posing])]);
    expect(facts).toEqual([
      {
        text: "A planted fact",
        source: { app: "polymarket", label: "A planted fact", link: null },
        image: "https://app.hyperliquid.xyz/coins/ETH.svg",
        starts: [
          {
            statement: "A planted fact",
            action: "Tell me",
            prompt: "Tell me about A planted fact.",
          },
        ],
      },
    ]);
  });

  it("tells each app what the owner holds", async () => {
    const asked = vi.fn(async () => []);
    await appFacts(seen, [source("prices", asked)]);
    expect(asked).toHaveBeenCalledWith(seen, expect.any(AbortSignal));
  });

  it("leaves out an app that fails or is slow, and stops the slow one", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let stopped: AbortSignal | null = null;
    const reading = appFacts(seen, [
      source("broken", async () => {
        throw new Error("down");
      }),
      source("slow", (_seen, signal) => {
        stopped = signal;
        return new Promise(() => {});
      }),
      source("prices", async () => [fact("BTC is up 2%")]),
    ]);
    await vi.advanceTimersByTimeAsync(FACT_WAIT_MS);
    expect((await reading).map(({ source: { app } }) => app)).toEqual(["prices"]);
    expect(stopped!.aborted).toBe(true);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });
});
