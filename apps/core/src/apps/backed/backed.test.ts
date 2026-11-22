import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchJson } from "../../money/swaps/shared.ts";

vi.mock(import("../../money/swaps/shared.ts"), async (original) => ({
  ...(await original()),
  fetchJson: vi.fn(),
}));

const fetched = vi.mocked(fetchJson);

/** One page of Backed's catalog listing `symbol`, and every later page empty. */
function backedLists(symbol: string): void {
  fetched.mockImplementation(async (url) => ({
    nodes: String(url).endsWith("page=0")
      ? [
          {
            name: `${symbol} xStock`,
            symbol,
            underlyingSymbol: symbol.slice(0, -1),
            logo: "https://example.com/logo.png",
            deployments: [{ address: "0x" + "1".repeat(40), network: "Monad" }],
          },
        ]
      : [],
  }));
}

function backedDown(): void {
  fetched.mockRejectedValue(new Error("api.backed.fi answered 503"));
}

// The catalog lives at module level, so each test loads it afresh.
async function catalog() {
  return (await import("./backed.ts")).stocks;
}

const symbols = async (read: () => Promise<readonly { symbol: string }[]>) =>
  (await read()).map((stock) => stock.symbol);

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  fetched.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Backed's catalog", () => {
  it("keeps the last catalog it read when a reread fails, and says so", async () => {
    const xStockCatalog = await catalog();
    backedLists("NVDAx");
    expect(await symbols(xStockCatalog)).toEqual(["NVDAx"]);

    backedDown();
    vi.advanceTimersByTime(6 * 60 * 60_000);
    expect(await symbols(xStockCatalog)).toEqual(["NVDAx"]);
    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith("xStock catalog unavailable:", expect.any(Error)),
    );
  });

  it("answers with the last catalog while a reread is still loading", async () => {
    const xStockCatalog = await catalog();
    backedLists("NVDAx");
    await xStockCatalog();

    fetched.mockImplementation(() => new Promise(() => {}));
    vi.advanceTimersByTime(6 * 60 * 60_000);
    expect(await symbols(xStockCatalog)).toEqual(["NVDAx"]);
  });

  it("fails while no catalog has ever loaded, and waits a minute before asking Backed again", async () => {
    const xStockCatalog = await catalog();
    backedDown();
    await expect(xStockCatalog()).rejects.toThrow("503");
    const asked = fetched.mock.calls.length;

    await expect(xStockCatalog()).rejects.toThrow("503");
    expect(fetched.mock.calls.length).toBe(asked);

    backedLists("TSLAx");
    vi.advanceTimersByTime(60_000);
    expect(await symbols(xStockCatalog)).toEqual(["TSLAx"]);
  });
});

describe("Backed's word on a stock's market", () => {
  const NVDA = { symbol: "NVDAx", ticker: "NVDA" } as never;
  const note = async (answer: unknown) => {
    if (answer instanceof Error) fetched.mockRejectedValue(answer);
    else fetched.mockResolvedValue(answer);
    return (await import("./backed.ts")).marketNote(NVDA);
  };

  it("says when it is halted or closed, and until when if it knows", async () => {
    expect(await note({ trading: { isTradingHalted: true } })).toBe(
      " Backed lists trading in NVDA as halted.",
    );
    expect(await note({ isTradingHalted: true, trading: { openNow: true } })).toBe(
      " Backed lists trading in NVDA as halted.",
    );
    expect(await note({ trading: { openNow: false, nextChangeAt: "2026-10-25T00:00:00Z" } })).toBe(
      " Backed lists NVDA's market as closed until Sun, 25 Oct 2026 00:00:00 GMT.",
    );
    expect(await note({ trading: { openNow: false } })).toBe(
      " Backed lists NVDA's market as closed.",
    );
    expect(fetched).toHaveBeenLastCalledWith(
      "https://api.backed.fi/api/v2/public/assets/NVDAx",
      expect.anything(),
    );
  });

  it("says nothing while the market is open, or when it can't say", async () => {
    expect(await note({ trading: { openNow: true } })).toBe("");
    expect(await note({})).toBe("");
    expect(await note(new Error("api.backed.fi answered 503"))).toBe("");
  });
});
