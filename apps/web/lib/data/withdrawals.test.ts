import { describe, expect, it } from "vitest";

import { cashWords, sentWords } from "./withdrawals";

const maxUsd = { base: "8.70", solana: "8.70", arbitrum: "8.70", monad: "8.70", polygon: "8.70" };

describe("cashWords", () => {
  it("says what is in the wallet to send, and where the rest of their cash is", () => {
    expect(
      cashWords({
        cashUsd: "9.29",
        walletUsd: "8.70",
        elsewhere: [
          { name: "Aave", usdValue: "0.49" },
          { name: "Polymarket", usdValue: "0.10" },
        ],
        maxUsd,
        recent: [],
      }),
    ).toBe(
      "$8.70 cash in your wallet. $0.49 at Aave and $0.10 at Polymarket: ask Auni to bring it " +
        "home first.",
    );
  });

  it("says just the cash when all of it is in the wallet", () => {
    expect(
      cashWords({ cashUsd: "8.70", walletUsd: "8.70", elsewhere: [], maxUsd, recent: [] }),
    ).toBe("$8.70 cash in your wallet. To send holdings, ask Auni to sell them first.");
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
      title: "$0.50 on its way",
      lede: "In seconds.",
    });
    const done = sentWords(sent, now("done"));
    expect(done.title).toBe("$0.50 arrived");
    expect(done.lede).toMatch(/^It reached your wallet on Base at \d{1,2}:04[ap]m\.$/u);
  });

  it("says it didn't go through, and why, once it failed", () => {
    expect(sentWords(sent, now("failed", "The network refused it. Nothing was sent."))).toEqual({
      title: "Withdrawal didn't go through",
      lede: "The network refused it. Nothing was sent.",
    });
  });
});
