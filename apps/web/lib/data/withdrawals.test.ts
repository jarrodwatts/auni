import { describe, expect, it } from "vitest";

import { cashWords, samePlace, sentWords } from "./withdrawals";

const maxUsd = { base: "8.70", solana: "8.70", arbitrum: "8.70", monad: "8.70", polygon: "8.70" };

describe("cashWords", () => {
  it("says what is in the wallet to send, and where the rest of their cash is", () => {
    expect(
      cashWords(
        {
          cashUsd: "9.29",
          walletUsd: "8.70",
          elsewhere: [
            { name: "Aave", usdValue: "0.49" },
            { name: "Polymarket", usdValue: "0.10" },
          ],
          maxUsd,
          recent: [],
        },
        "base",
      ),
    ).toBe(
      "$8.70 USDC in your wallet. $0.49 on Aave and $0.10 on Polymarket: ask Auni to move it " +
        "back first.",
    );
  });

  it("says just the cash when all of it is in the wallet", () => {
    expect(
      cashWords({ cashUsd: "8.70", walletUsd: "8.70", elsewhere: [], maxUsd, recent: [] }, "base"),
    ).toBe("$8.70 USDC in your wallet. To withdraw other holdings, ask Auni to sell them first.");
  });

  // $5 on Base and $5 on Arbitrum said "$10 USDC in your wallet" while Max filled $5.00
  // (review of 2026-11-25).
  it("says the most one withdrawal sends there, what Max fills, when cash is spread", () => {
    const spread = {
      base: "5.00",
      solana: "0.00",
      arbitrum: "5.00",
      monad: "5.00",
      polygon: "5.00",
    };
    expect(
      cashWords(
        { cashUsd: "10", walletUsd: "10", elsewhere: [], maxUsd: spread, recent: [] },
        "base",
      ),
    ).toBe(
      "$10 USDC in your wallet, but one withdrawal on Base can send up to $5. Ask Auni to " +
        "gather it first for more.",
    );
  });
});

describe("samePlace", () => {
  // The tick on a past place went when its read came again as new objects (review of 2026-11-25).
  it("is the same network and address, whichever read it came from", () => {
    const place = {
      network: "base" as const,
      address: "0x2222222222222222222222222222222222222222",
    };
    expect(samePlace(place, { ...place })).toBe(true);
    expect(samePlace(place, { ...place, network: "arbitrum" })).toBe(false);
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
      lede: "Arrives in seconds.",
    });
    const done = sentWords(sent, now("done"));
    expect(done.title).toBe("$0.50 arrived");
    // Theirs, never "your wallet", which is Auni's.
    expect(done.lede).toMatch(/^Reached your other wallet on Base at \d{1,2}:04[ap]m\.$/u);
  });

  // "$120 arrived" for $120 sent between networks, of which the bridge kept $1.25 (review of
  // 2026-11-25).
  it("says what lands, less the fee, for a withdrawal moved between networks", () => {
    const bridged = (status: "running" | "done") => ({
      ...now(status),
      amountUsd: "120.00",
      details: { arrives: "In about a minute", fee: "$1.25", landsUsd: "118.75" },
    });
    expect(sentWords(sent, bridged("running"))).toEqual({
      title: "$120 on its way",
      lede: "About $118.75 arrives in about a minute, after the $1.25 fee to move it between networks.",
    });
    const done = sentWords(sent, bridged("done"));
    expect(done.title).toBe("About $118.75 arrived");
    expect(done.lede).toMatch(
      /^Reached your other wallet on Base at \d{1,2}:04[ap]m\. \$120 left your wallet, and moving it between networks cost \$1\.25\.$/u,
    );
  });

  it("says it didn't go through, and why, once it failed", () => {
    expect(sentWords(sent, now("failed", "The network refused it. Nothing was sent."))).toEqual({
      title: "Withdrawal didn't go through",
      lede: "The network refused it. Nothing was sent.",
    });
  });
});
