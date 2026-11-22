import { NETWORKS } from "@auni/shared";
import { expect, vi } from "vitest";

import { holdsToCard } from "../../test/held-to-card.ts";
import { publicClient } from "../chains.ts";
import { simulateEffect, tokenNames, type SimulatedEffect } from "../wallet-effect.ts";

// The agent's own calls on Base, which Auni reads only by simulating them from the wallet: the
// card is what that simulation showed, and execute simulates them again. What the calls would
// do by then is `does`, which each case changes.
const APP = "0x2222222222222222222222222222222222222222" as const;
const FRIEND = "0x7777777777777777777777777777777777777777" as const;
const STRANGER = "0x5555555555555555555555555555555555555555" as const;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;
/** A token no feed prices. */
const MYSTERY = "0x9999999999999999999999999999999999999999" as const;

// Null while the calls do what their card was drawn from: the swap, or the payment.
const world = vi.hoisted(() => ({ does: null as Partial<SimulatedEffect> | null }));

vi.mock(import("../wallet-effect.ts"), async (original) => ({
  ...(await original()),
  simulateEffect: vi.fn(),
  tokenNames: vi.fn(),
}));
vi.mock(import("../app-logo.ts"), () => ({ appLogo: async () => null }));
vi.mock(import("../wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => (await import("../../test/wallets.ts")).OWNER.evm,
  paysOwnGas: async () => false,
}));

const USDC_100 = { token: USDC, amount: 100_000_000n };
const WETH_QUARTER = { token: WETH, amount: 25n * 10n ** 15n };
/** A swap on an app Auni has no tool for: $100 of USDC for 0.025 WETH. */
const SWAP = { out: [USDC_100], in: [WETH_QUARTER] };
/** $100 of USDC to a friend, with nothing back. */
const PAYMENT = { out: [USDC_100], sentTo: [FRIEND] };
/** 500 of a token Auni can't price to a friend, with nothing back. */
const UNPRICED = { out: [{ token: MYSTERY, amount: 500n * 10n ** 18n }], sentTo: [FRIEND] };
/** Both at once: $100 of USDC and the token Auni can't price, through one contract. */
const BOTH = { out: [USDC_100, ...UNPRICED.out], sentTo: [FRIEND] };
const SPLITTER = "0x8888888888888888888888888888888888888888" as const;

/** The contract each kind of call goes to, which the simulation's stand-in tells it by. */
const TARGETS = [
  [USDC, PAYMENT],
  [MYSTERY, UNPRICED],
  [SPLITTER, BOTH],
] as const;

const calls = (does: Partial<SimulatedEffect>) => ({
  chain: "base",
  calls: [{ to: TARGETS.find(([, each]) => each === does)?.[0] ?? APP, data: "0x12345678" }],
  summary:
    does === PAYMENT
      ? "Pay a friend $100"
      : does === SWAP
        ? "Swap $100 of USDC for WETH"
        : "Send a friend 500 MYST",
});
/** Runs the case in `does`'s world, then changes what the calls would do to `then`. */
const inWorld = (does: Partial<SimulatedEffect>, then: Partial<SimulatedEffect>) => ({
  input: calls(does),
  after: () => {
    world.does = then;
  },
});

holdsToCard("send_evm_transaction", {
  world() {
    vi.mocked(tokenNames).mockResolvedValue(
      new Map([
        [USDC, { symbol: "USDC", decimals: 6, usd: 1 }],
        [WETH, { symbol: "WETH", decimals: 18, usd: 4000 }],
      ]),
    );
    vi.mocked(simulateEffect).mockImplementation(async (_, __, sent) => ({
      out: [],
      in: [],
      grants: [],
      blind: false,
      sentTo: [],
      logs: [],
      ...(world.does ?? TARGETS.find(([to]) => to === sent[0]!.to)?.[1] ?? SWAP),
    }));
    world.does = null;
    vi.spyOn(publicClient("base"), "waitForTransactionReceipt").mockResolvedValue({
      logs: [],
    } as never);
  },
  asShown: {
    "a swap on an app Auni has no tool for": calls(SWAP),
    "a payment to a friend": calls(PAYMENT),
    // The agent has no say in the card's dollars: a figure it gives is not even read.
    "the same swap, which the agent says moves $5": { ...calls(SWAP), amount_usd: "5" },
    "the same payment, which the agent says moves nothing": { ...calls(PAYMENT), amount_usd: "0" },
    "a payment of a token Auni can't price": calls(UNPRICED),
    "a payment of dollars and a token Auni can't price together": calls(BOTH),
  },
  paysAsShown(signed, card) {
    // Exactly the calls its card was simulated from, as one batch on the chain it named.
    expect(signed.evm).toEqual([{ chainId: NETWORKS.base.viem.id, txs: card.input.calls }]);
    // Its card's dollars are what the simulation saw those calls send, at the listed prices,
    // and nothing where a price is missing: never a figure the agent gave. Execute refuses a
    // run that would send more than its card showed (takesMore), so the two can't part.
    // Part of what leaves priced is not a price for what leaves, so that card shows none.
    const [{ to }] = card.input.calls as [{ to: string }];
    expect(card.amountUsd).toBe(to === MYSTERY || to === SPLITTER ? "0.00" : "100.00");
  },
  priceMoved: {
    "a swap that would now get 5% less WETH back": inWorld(SWAP, {
      ...SWAP,
      in: [{ token: WETH, amount: (WETH_QUARTER.amount * 95n) / 100n }],
    }),
  },
  takesMore: {
    "a swap that would now take more USDC than its card showed": inWorld(SWAP, {
      ...SWAP,
      out: [{ token: USDC, amount: 101_000_000n }],
    }),
    "a swap that would now also send WETH out": inWorld(SWAP, {
      out: [USDC_100, WETH_QUARTER],
      in: [WETH_QUARTER],
    }),
  },
  paysElsewhere: {
    "a payment that would now go to someone else": inWorld(PAYMENT, {
      ...PAYMENT,
      sentTo: [STRANGER],
    }),
    "a swap that would now leave someone a lasting approval": inWorld(SWAP, {
      ...SWAP,
      grants: [{ kind: "spend", token: USDC, to: STRANGER }],
    } as Partial<SimulatedEffect>),
  },
});
