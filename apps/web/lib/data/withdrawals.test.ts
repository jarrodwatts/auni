import { describe, expect, it } from "vitest";

import { cashWords, sentWords } from "./withdrawals";

const maxUsd = { base: "8.70", solana: "8.70", arbitrum: "8.70", monad: "8.70", polygon: "8.70" };

describe("cashWords", () => {
  it("says all their cash, as the portfolio does, and what is in the wallet to send", () => {
    expect(
      cashWords({
        cashUsd: "9.29",
        walletUsd: "8.70",
        elsewhere: [
          { name: "Aave", usdValue: "0.49" },
          { name: "Polymarket", usdValue: "0.10" },
        ],
        maxUsd,
      }),
    ).toBe(
      "You have $9.29 in cash: $8.70 in your wallet to send, and $0.49 at Aave and $0.10 at " +
        "Polymarket. Ask Auni to bring that home, or to sell holdings to cash.",
    );
  });

  it("says just the cash when all of it is in the wallet", () => {
    expect(cashWords({ cashUsd: "8.70", walletUsd: "8.70", elsewhere: [], maxUsd })).toBe(
      "You have $8.70 in cash. Holdings sell to cash first: ask Auni.",
    );
  });
});

// Real use: "On its way. In seconds." still showed 26 s after the money landed.
describe("sentWords", () => {
  const sent = {
    review: {
      address: "0x2222222222222222222222222222222222222222",
      network: "base" as const,
      destination: "wallet" as const,
      newAddress: false,
      lookalike: null,
    },
  };
  const now = (status: "running" | "done" | "failed", error: string | null = null) => ({
    status,
    amountUsd: "0.50",
    details: { arrives: "In seconds" },
    error,
    updatedAt: "2026-11-14T05:04:00Z",
  });

  it("says it is on its way while it runs, then that it arrived, where and when", () => {
    expect(sentWords(sent, now("running"))).toEqual({
      title: "On its way",
      lede: "In seconds.",
    });
    const done = sentWords(sent, now("done"));
    expect(done.title).toBe("It arrived");
    expect(done.lede).toMatch(/^\$0\.50 reached your wallet on Base at \d{1,2}:04[ap]m\.$/u);
  });

  it("says it didn't go through, and why, once it failed", () => {
    expect(sentWords(sent, now("failed", "The network refused it. Nothing was sent."))).toEqual({
      title: "It didn’t go through",
      lede: "The network refused it. Nothing was sent.",
    });
  });
});
