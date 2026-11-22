import { NETWORKS } from "@auni/shared";
import { expect, vi } from "vitest";

import { holdsToCard } from "../../test/held-to-card.ts";
import { landedEffect, simulateSolana, type SolanaSimulation } from "../solana-effect.ts";
import { solanaPrice, solanaTokens } from "../swaps/solana-swap.ts";
import type { Simulated } from "../wallet-effect.ts";

// A transaction a Solana app built for the wallet, which Auni reads only by simulating it: the
// card is what that simulation showed, and execute simulates it again. The wallet holds the SOL
// its fee takes. What it would do by then is `does`, which each case changes.
const USDC = NETWORKS.solana.usdc;
const JUP = "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN";
const STRANGER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
// A swap of $100 of USDC for 200 JUP at $0.50.
const SWAP: Simulated = {
  out: [{ token: USDC, amount: 100_000_000n }],
  in: [{ token: JUP, amount: 200_000_000n }],
  grants: [],
};
const TRANSACTION = Buffer.from("an app's swap for the wallet").toString("base64");

// Null while it does what its card was drawn from.
const world = vi.hoisted(() => ({ does: null as Simulated | null }));

vi.mock(import("../solana-effect.ts"), async (original) => ({
  ...(await original()),
  simulateSolana: vi.fn(),
  landedEffect: vi.fn(),
}));
vi.mock(import("../swaps/solana-swap.ts"), async (original) => ({
  ...(await original()),
  solanaTokens: vi.fn(),
  solanaPrice: vi.fn(),
}));
vi.mock(import("../token-feeds.ts"), async (original) => ({
  ...(await original()),
  solUsd: async () => 150,
}));
vi.mock(import("../app-logo.ts"), () => ({ appLogo: async () => null }));
vi.mock(import("../wallets.ts"), async (original) => ({
  ...(await original()),
  solanaAddress: async () => (await import("../../test/wallets.ts")).OWNER.solana,
}));

const token = (mint: string, symbol: string) => ({
  mint,
  symbol,
  name: symbol,
  decimals: 6,
  verified: true,
});
const swap = { transaction: TRANSACTION, summary: "Swap $100 of USDC for JUP" };
const doing = (then: Simulated) => ({
  input: swap,
  after: () => {
    world.does = then;
  },
});

holdsToCard("send_solana_transaction", {
  world() {
    world.does = null;
    vi.mocked(solanaTokens).mockResolvedValue([token(USDC, "USDC"), token(JUP, "JUP")] as never);
    vi.mocked(solanaPrice).mockImplementation(async (mint) => ({
      usdPrice: mint === USDC ? 1 : 0.5,
      multiplier: 1,
    }));
    vi.mocked(simulateSolana).mockImplementation(
      async (transaction) =>
        ({
          effect: world.does ?? SWAP,
          fee: 5_000n,
          rent: 0n,
          short: 0n,
          position: null,
          via: "an app",
          decimals: new Map([
            [USDC, 6],
            [JUP, 6],
          ]),
          wire: async () => transaction,
        }) satisfies SolanaSimulation,
    );
    vi.mocked(landedEffect).mockResolvedValue({ ...SWAP } as never);
  },
  asShown: {
    "a swap on a Solana app Auni has no tool for": swap,
    // The agent has no say in the card's dollars: a figure it gives is not even read.
    "the same swap, which the agent says moves $5": { ...swap, amount_usd: "5" },
  },
  paysAsShown(signed, card) {
    // Exactly the transaction its card was simulated from, paying its own fee.
    expect(signed.solana).toEqual([{ base64Tx: TRANSACTION, setup: false }]);
    expect(signed.evm).toEqual([]);
    // Its card's dollars are what the simulation saw leave, at the listed prices: $100 of USDC.
    expect(card.amountUsd).toBe("100.00");
  },
  priceMoved: {
    "a swap that would now get 5% less JUP back": doing({
      ...SWAP,
      in: [{ token: JUP, amount: 190_000_000n }],
    }),
  },
  takesMore: {
    "a swap that would now take more USDC than its card showed": doing({
      ...SWAP,
      out: [{ token: USDC, amount: 101_000_000n }],
    }),
    "a swap that would now also send JUP out": doing({
      ...SWAP,
      out: [...SWAP.out, { token: JUP, amount: 1_000_000n }],
    }),
  },
  paysElsewhere: {
    "a swap that would now let someone else move the wallet's USDC": doing({
      ...SWAP,
      grants: [{ kind: "spend", token: USDC, to: STRANGER }],
    }),
  },
});
