import { EVM_CHAIN_KEYS, type NetworkKey } from "@auni/shared";
import { vi } from "vitest";

import { chainKey, publicClient } from "../money/chains.ts";
import { fillIdentity } from "../money/fill-key.ts";
import { readTokens, solanaTokens } from "../money/chain-holdings.ts";
import type { Transfer } from "../money/transfers.ts";

/**
 * Their wallets as the chain holds them, stood in for: what each transfer
 * moved in, less what left, as of the chain's head, which each move brings to
 * its own block, as what a token's worth is read from when it begins to
 * count (see startCounting in money/other-tokens.ts). A test file mocks
 * money/chain-holdings.ts with test/chain.ts's `holdings` for this to fill in;
 * every other read stays its own.
 */
export function fakeWallet() {
  let head = 0;
  const held = new Map<
    string,
    { chain: string; instrument: string; units: bigint; priced: bigint; decimals: number }
  >();
  const blocks = new Map<string, number>();
  const of = (chain: string, instrument: string) => held.get(fillIdentity({ chain, instrument }));
  for (const chain of EVM_CHAIN_KEYS) {
    vi.spyOn(publicClient(chain), "getBlockNumber").mockImplementation(async () => BigInt(head));
    vi.spyOn(publicClient(chain), "getBalance").mockImplementation(
      async () => of(chain, "native")?.units ?? 0n,
    );
  }
  vi.mocked(readTokens).mockImplementation(async (client, _owner, tokens) => {
    const chain = chainKey(client.chain!.id);
    return tokens.map((token) => {
      const one = of(chain, token);
      return {
        token,
        balance: one?.units ?? 0n,
        ...(one && one.priced !== one.units ? { pricedUnits: one.priced } : {}),
        decimals: one?.decimals ?? 18,
        symbol: "",
      };
    });
  });
  vi.mocked(solanaTokens).mockImplementation(async () => ({
    slot: head,
    byMint: new Map(
      [...held.values()].flatMap(({ chain, instrument, units, decimals }) =>
        chain === "solana" ? [[instrument, { amount: units, decimals, slot: head }] as const] : [],
      ),
    ),
  }));
  return {
    /** The chain's head, as a read now sees it. */
    get head() {
      return head;
    },
    /**
     * The chain takes transaction `hash`, moving `transfers` on `chain`, at
     * `block`, by default the next, which becomes its head, once however
     * often it is asked; its block. An account holds no less than none.
     */
    move(
      chain: NetworkKey,
      hash: string,
      transfers: readonly Transfer[],
      block = head + 1,
    ): number {
      const taken = blocks.get(hash);
      if (taken !== undefined) return taken;
      blocks.set(hash, block);
      for (const { instrument, baseUnits, pricedUnits, decimals } of transfers) {
        const before = of(chain, instrument) ?? { units: 0n, priced: 0n };
        const units = before.units + baseUnits;
        held.set(fillIdentity({ chain, instrument }), {
          chain,
          instrument,
          units: units > 0n ? units : 0n,
          priced: units > 0n ? before.priced + (pricedUnits ?? baseUnits) : 0n,
          decimals,
        });
      }
      head = Math.max(head, block);
      return block;
    },
  };
}
