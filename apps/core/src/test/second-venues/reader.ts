import { vi } from "vitest";

import { defineApp, type Reading } from "../../apps/contract.ts";
import { ABOUT } from "./about.ts";

/**
 * A staking pool on Base the agent reaches by building the transaction itself. The app has no
 * money code: it knows the pool's address and reads a call to it, so the card wears its name and
 * its words while the simulation says everything that moves.
 */
export const STAKING_POOL = "0x00000000000000000000000000000000000057a1";
/** stake(uint256), the one call the reader knows. */
export const STAKE = "0xa694fc3a";

/** What the reader says of a call to the pool, which a test may change. */
export const readStake = vi.fn((data: string): Reading | null =>
  data.startsWith(STAKE)
    ? {
        title: "Stake USDC with Fake Staking",
        verb: "deposit",
        finePrint: "Taking it back out takes a week.",
      }
    : null,
);

export default defineApp({
  about: ABOUT.reader,
  addresses: async (chain) =>
    chain === "base" ? new Map([[STAKING_POOL, "Fake Staking's pool"]]) : new Map(),
  reads: (_chain, calls) => readStake(calls.at(-1)!.data),
});
