import { afterEach, describe, expect, it, vi } from "vitest";

import { readTokens } from "./chain-holdings.ts";
import { evmXStocks } from "./swaps/xstocks.ts";

vi.mock("./swaps/xstocks.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  evmXStocks: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

const OWNER = "0x1111111111111111111111111111111111111111";
const STOCK = "0x1aad217b8f78dba5e6693460e8470f8b1a3977f3";
const TOKEN = "0x88fb150bdc53a65fe94dea0c9ba0a6daf8c6e196";

/**
 * A chain where the wallet holds 1.097 of the xStock, one share, and 5 of the other token; the
 * reads named in `failing` (`<address> <function>`) revert.
 */
function chain(failing: readonly string[] = []) {
  const symbols: Record<string, string> = { [STOCK]: "STRCx", [TOKEN]: "LINK" };
  const balances: Record<string, bigint> = {
    [STOCK]: 1_097n * 10n ** 15n,
    [TOKEN]: 5n * 10n ** 18n,
  };
  return {
    multicall: vi.fn(
      async ({ contracts }: { contracts: { address: string; functionName: string }[] }) =>
        contracts.map(({ address, functionName }) =>
          failing.includes(`${address} ${functionName}`)
            ? { status: "failure", error: new Error(`${functionName} reverted`) }
            : {
                status: "success",
                result:
                  functionName === "balanceOf"
                    ? balances[address]
                    : functionName === "decimals"
                      ? 18
                      : symbols[address],
              },
        ),
    ),
    readContract: vi.fn(async () => 10n ** 18n),
  };
}

describe("readTokens", () => {
  it("reads an xStock's shares, which its price counts, as of the same block as its balance", async () => {
    vi.mocked(evmXStocks).mockResolvedValue(new Set([STOCK]));
    const client = chain();
    const read = await readTokens(client as never, OWNER, [STOCK, TOKEN], {
      strict: false,
      blockNumber: 100n,
    });
    expect(read).toEqual([
      {
        token: STOCK,
        balance: 1_097n * 10n ** 15n,
        pricedUnits: 10n ** 18n,
        decimals: 18,
        symbol: "STRCx",
      },
      { token: TOKEN, balance: 5n * 10n ** 18n, decimals: 18, symbol: "LINK" },
    ]);
    expect(client.multicall).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 100n }));
    expect(client.readContract).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ address: STOCK, functionName: "sharesOf", blockNumber: 100n }),
    );
  });

  it("counts the chain unread while no catalog can tell a held xStock apart, as its balance would price it too high", async () => {
    vi.mocked(evmXStocks).mockRejectedValue(new Error("catalog down"));
    await expect(
      readTokens(chain() as never, OWNER, [STOCK, TOKEN], { strict: false }),
    ).rejects.toThrow("xStock catalog");
    // With none of that kind held, nothing needs the catalog.
    await expect(
      readTokens(chain() as never, OWNER, [TOKEN], { strict: false }),
    ).resolves.toHaveLength(1);
  });

  it("counts the chain unread when a token Auni bought fails any read, its symbol too", async () => {
    vi.mocked(evmXStocks).mockResolvedValue(new Set([STOCK]));
    await expect(
      readTokens(chain([`${TOKEN} symbol`]) as never, OWNER, [STOCK, TOKEN], { strict: true }),
    ).rejects.toThrow("symbol reverted");
  });

  it("leaves out a token that only arrived and won't answer, and keeps one whose symbol won't", async () => {
    vi.mocked(evmXStocks).mockResolvedValue(new Set([STOCK]));
    const read = await readTokens(
      chain([`${STOCK} balanceOf`, `${TOKEN} symbol`]) as never,
      OWNER,
      [STOCK, TOKEN],
      { strict: false },
    );
    expect(read).toEqual([{ token: TOKEN, balance: 5n * 10n ** 18n, decimals: 18, symbol: "" }]);
  });
});
