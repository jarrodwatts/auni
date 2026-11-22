import { afterEach, describe, expect, it, vi } from "vitest";

import { STAKE, STAKING_POOL, readStake } from "../test/second-venues/reader.ts";
import { approval, effectLines } from "./effect.ts";
import { sendEvmTransaction } from "./recipes/evm.ts";
import { simulateEffect, tokenNames, type SimulatedEffect } from "./wallet-effect.ts";

// An app whose contracts a transaction the agent built calls, every call of it, names its card
// and words it, and changes nothing the simulation says: what moves, the dollars, tap or proof.
// The fake reader (test/second-venues/reader.ts) is installed as `pnpm gen` would install it.

vi.mock(import("../apps/index.generated.ts"), async (original) =>
  (await import("../test/second-venues/index.ts")).withSecondVenues(await original()),
);
vi.mock(import("@auni/shared"), async (original) =>
  (await import("../test/second-venues/about.ts")).withTheirListings(await original()),
);
vi.mock("./wallet-effect.ts", async (original) => ({
  ...(await original()),
  simulateEffect: vi.fn(),
  tokenNames: vi.fn(),
}));
vi.mock("./app-logo.ts", () => ({ appLogo: async () => null }));
vi.mock("./wallets.ts", async (original) => ({
  ...(await original()),
  evmAddress: async () => OWNER,
  paysOwnGas: async () => false,
}));

const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SHARES = "0x5555555555555555555555555555555555555555";
/** A contract no app knows. */
const ELSEWHERE = "0x2222222222222222222222222222222222222222";
vi.mocked(tokenNames).mockResolvedValue(
  new Map([
    [USDC, { symbol: "USDC", decimals: 6, usd: 1 }],
    [SHARES, { symbol: "fsUSDC", decimals: 6, usd: 1 }],
  ]),
);

const seen = (effect: Partial<SimulatedEffect>): SimulatedEffect => ({
  out: [],
  in: [],
  grants: [],
  blind: false,
  sentTo: [],
  logs: [],
  ...effect,
});
/** Puts $50 of USDC in and gets the pool's shares back. */
const staked = seen({
  out: [{ token: USDC, amount: 50_000_000n }],
  in: [{ token: SHARES, amount: 50_000_000n }],
});
/** Sends $50 of USDC with nothing back. */
const given = seen({ out: [{ token: USDC, amount: 50_000_000n }], sentTo: [STAKING_POOL] });

/** The agent's card for a batch ending at `to`, named for an app it says is Uniswap. */
const describeAt = (to: string) =>
  sendEvmTransaction.describe(
    {
      chain: "base",
      calls: [{ to, data: `${STAKE}${"0".repeat(64)}` }],
      summary: "Put $50 into the pool",
      app: {
        name: "Uniswap",
        site: "uniswap.org",
        verb: "swap",
        note: "Uniswap pays you 9% a year.",
      },
    },
    {},
  );

afterEach(() => {
  readStake.mockClear();
});

describe("a transaction the agent built, at a contract an app knows", () => {
  it("wears the app's name and its reader's words, whatever the agent's hint said", async () => {
    vi.mocked(simulateEffect).mockResolvedValue(staked);
    const card = await describeAt(STAKING_POOL);
    expect(card.summary).toBe("Stake USDC with Fake Staking");
    expect(card.card?.title).toBe("Stake USDC with Fake Staking");
    expect(card.card?.receipt.title).toBe("Put USDC into Fake Staking");
    expect(card.card?.context).toBe("Fake Staking on Base");
    expect(card.card?.finePrint).toContain("Taking it back out takes a week.");
    expect(JSON.stringify(card)).not.toContain("Uniswap");
    // The app vouches for it, so the card is the app's own: no heading sets anything apart.
    expect(card.card?.checks).toBeUndefined();
    expect((await describeAt(ELSEWHERE)).card?.checks?.unchecked?.says).toBe(
      "Uniswap pays you 9% a year.",
    );
  });

  it("finds the contract whatever case the agent wrote its address in", async () => {
    vi.mocked(simulateEffect).mockResolvedValue(staked);
    const card = await describeAt(STAKING_POOL.toUpperCase().replace("0X", "0x"));
    expect(card.card?.context).toBe("Fake Staking on Base");
  });

  it.each([
    ["a deposit", staked],
    ["a send with nothing back", given],
  ])("shows %s moving exactly as it would with no app at all", async (_, simulated) => {
    vi.mocked(simulateEffect).mockResolvedValue(simulated);
    const read = await describeAt(STAKING_POOL);
    const plain = await describeAt(ELSEWHERE);
    expect(read.effect).toEqual(plain.effect);
    expect(effectLines(read.effect)).toEqual(effectLines(plain.effect));
    expect(read.amountUsd).toBe(plain.amountUsd);
    expect(approval(read.effect, [])).toEqual(approval(plain.effect, []));
    expect(read.details).toEqual({
      ...plain.details,
      ...(plain.details?.app ? { app: "Fake Staking" } : {}),
    });
  });

  it.each([
    [
      "throws",
      () => {
        throw new Error("bad calldata");
      },
    ],
    ["says nothing", () => null],
    [
      "types dollars into its title",
      () => ({ title: "Stake $50 with Fake Staking", verb: "deposit" }),
    ],
  ])("leaves the plain card under the app's name when its reader %s", async (_, reads) => {
    vi.mocked(simulateEffect).mockResolvedValue(staked);
    readStake.mockImplementationOnce(reads);
    const card = await describeAt(STAKING_POOL);
    expect(card.summary).toBe("Put $50 into the pool");
    expect(card.card?.title).toBe("Put $50 into the pool");
    expect(card.card?.context).toBe("Fake Staking on Base");
  });

  it("asks no reader of a transaction it couldn't simulate, and still names the app", async () => {
    vi.mocked(simulateEffect).mockResolvedValue(null);
    const card = await describeAt(STAKING_POOL);
    expect(readStake).not.toHaveBeenCalled();
    expect(card.details?.app).toBe("Fake Staking");
    expect(card.summary).toBe("Put $50 into the pool");
  });

  /** The agent's card for a batch of `first`, then a stake at the pool. */
  const describeAfter = (first: { readonly to: string; readonly data: string }) =>
    sendEvmTransaction.describe(
      {
        chain: "base",
        calls: [first, { to: STAKING_POOL, data: `${STAKE}${"0".repeat(64)}` }],
        summary: "Put $50 into the pool",
        app: { name: "Uniswap", site: "uniswap.org", verb: "swap" },
      },
      {},
    );
  const word = (address: string) => address.slice(2).toLowerCase().padStart(64, "0");
  const fifty = 50_000_000n.toString(16).padStart(64, "0");
  const STRANGER = "0x9999999999999999999999999999999999999999";

  it("vouches for a batch that approves its own contract before it calls it", async () => {
    vi.mocked(simulateEffect).mockResolvedValue(staked);
    const card = await describeAfter({ to: USDC, data: `0x095ea7b3${word(STAKING_POOL)}${fifty}` });
    expect(card.summary).toBe("Stake USDC with Fake Staking");
    expect(card.card?.context).toBe("Fake Staking on Base");
  });

  it.each([
    ["pays a stranger", `0xa9059cbb${word(STRANGER)}${fifty}`],
    ["approves a stranger", `0x095ea7b3${word(STRANGER)}${fifty}`],
  ])("never vouches for a batch that %s before it ends at its contract", async (_, data) => {
    vi.mocked(simulateEffect).mockResolvedValue(
      seen({ out: [{ token: USDC, amount: 50_000_000n }], sentTo: [STRANGER] }),
    );
    const card = await describeAfter({ to: USDC, data });
    expect(readStake).not.toHaveBeenCalled();
    expect(card.summary).toBe("Put $50 into the pool");
    expect(JSON.stringify(card)).not.toContain("Fake Staking");
  });

  it("keeps the agent's hint at a contract no app knows", async () => {
    vi.mocked(simulateEffect).mockResolvedValue(staked);
    const card = await describeAt(ELSEWHERE);
    expect(card.card?.context).toBe("Uniswap on Base");
    expect(readStake).not.toHaveBeenCalled();
  });
});
