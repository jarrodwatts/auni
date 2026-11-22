import { vi } from "vitest";

import type * as Holdings from "../money/chain-holdings.ts";
import type * as History from "../money/history.ts";
import type * as Recognised from "../money/recognised.ts";
import type * as Transfers from "../money/transfers.ts";
import type * as Wallets from "../money/wallets.ts";

// One chain, stood in for, shared by the money db tests that read what moved in and out of the
// wallet. Each fake takes the real module and returns it with its chain reads replaced; a test
// file mocks with them, keeping its own tokens and prices:
//
//   vi.mock("./history.ts", async (o) => (await import("../test/chain.ts")).history(await o(), PRICES));
//
// The factory runs before the file's own consts exist, so what it passes is literal or from
// vi.hoisted. This file imports nothing the factories replace.

/** The owner's EVM wallet in these tests. */
export const WALLET = "0x1111111111111111111111111111111111111111";

/** money/wallets.ts: the owner's addresses, with no wallet app asked. */
export function wallets(original: unknown, solana: string | null = null): typeof Wallets {
  return {
    ...(original as typeof Wallets),
    walletAddresses: async () => ({ evm: WALLET, solana }),
  };
}

/** money/recognised.ts: `listings` is a vi.fn() each test fills with listingsOf (test/recognised.ts). */
export function recognised(original: unknown): typeof Recognised {
  return { ...(original as typeof Recognised), listings: vi.fn() };
}

/** money/history.ts: each id priced as `prices` says, when it moved and now; anything else unpriced. */
export function history(
  original: unknown,
  prices: Readonly<Record<string, { readonly price: number; readonly symbol?: string }>>,
): typeof History {
  const priced = (ids: readonly string[]) =>
    new Map(ids.flatMap((id) => (prices[id] ? [[id, prices[id]] as const] : [])));
  const tokenPrices = vi.fn(async (ids: readonly string[]) => ({
    prices: priced(ids),
    complete: true,
  }));
  return {
    ...(original as typeof History),
    // By price key, a token's being "token:<its id>" (see priceKey).
    pricesAt: async (keys) =>
      new Map(
        keys.flatMap((key) => {
          const price = prices[key.replace(/^token:/u, "")]?.price;
          return price === undefined ? [] : [[key, price] as const];
        }),
      ),
    tokenPrices,
    // By price key too, from the same stand-in feed a test may change.
    pricesNow: async (keys) => {
      const read = await tokenPrices(keys.map((key) => key.replace(/^token:/u, "")));
      const now = keys.flatMap((key) => {
        const price = read.prices.get(key.replace(/^token:/u, ""))?.price;
        return price === undefined ? [] : [[key, price] as const];
      });
      return { prices: new Map(now), complete: read.complete };
    },
  };
}

/** money/transfers.ts: `readTransfers` is a vi.fn() each test says a transaction's moves with. */
export function transfers(original: unknown): typeof Transfers {
  return { ...(original as typeof Transfers), readTransfers: vi.fn() };
}

/** money/chain-holdings.ts: the balance reads fakeWallet (test/wallet.ts) answers. */
export function holdings(original: unknown): typeof Holdings {
  return { ...(original as typeof Holdings), readTokens: vi.fn(), solanaTokens: vi.fn() };
}
