import { describe, expect, it } from "vitest";

import { cashWords, samePlace, sentWords } from "./withdrawals";

const maxUsd = { base: "8.70", solana: "8.70", arbitrum: "8.70", monad: "8.70", polygon: "8.70" };

describe("cashWords", () => {
  const cash = (fields: Partial<Parameters<typeof cashWords>[0]> = {}) => ({
    cashUsd: "8.70",
    walletUsd: "8.70",
    elsewhere: [],
    maxUsd,
    recent: [],
    ...fields,
  });
  const atApps = [
    { name: "Aave", usdValue: "0.49" },
    { name: "Polymarket", usdValue: "0.10" },
  ];
  // $5 on Base and $5 on Arbitrum: one withdrawal sends $5 on any EVM network, and $5 on Solana.
  const spread = { base: "5.00", solana: "5.00", arbitrum: "5.00", monad: "5.00", polygon: "5.00" };

  // At rest it read "$8,889 USDC in your wallet, but one withdrawal on Base can send up to
  // $5,270. Ask Auni to gather it first for more. $4,000 on Aave...", before anything was typed
  // (review of 2026-11-25).
  it("is one short line until the amount is more than can leave", () => {
    for (const typed of ["", "0", "8.70", "$8.70", "abc"])
      expect(cashWords(cash({ elsewhere: atApps }), "base", typed)).toEqual({
        words: "$8.70 USDC in your wallet.",
        over: false,
      });
    expect(cashWords(cash({ walletUsd: "10", maxUsd: spread }), "base", "5")).toEqual({
      words: "$10 USDC in your wallet.",
      over: false,
    });
  });

  it("says how far one withdrawal goes, and to gather the rest, once more is typed", () => {
    expect(cashWords(cash({ walletUsd: "10", maxUsd: spread }), "base", "7")).toEqual({
      words: "One withdrawal on Base can send up to $5. Ask Auni to gather the rest first.",
      over: true,
    });
  });

  it("says where the rest of their cash is once the amount is more than the wallet holds", () => {
    expect(cashWords(cash({ elsewhere: atApps }), "base", "9")).toEqual({
      words:
        "One withdrawal on Base can send up to $8.70. $0.49 on Aave and $0.10 on Polymarket: " +
        "ask Auni to move it back first.",
      over: true,
    });
    expect(cashWords(cash(), "base", "9").words).toBe(
      "One withdrawal on Base can send up to $8.70. To withdraw other holdings, ask Auni to sell " +
        "them first.",
    );
  });

  // $10 on Solana only, withdrawn on Base, said "one withdrawal on Base can send up to $0. Ask
  // Auni to gather it first for more", which can't help: Solana's cash leaves only on Solana
  // (review of 2026-11-25).
  it("names the network the cash leaves from, never a limit of $0", () => {
    const onSolana = {
      base: "0.00",
      solana: "10.00",
      arbitrum: "0.00",
      monad: "0.00",
      polygon: "0.00",
    };
    for (const typed of ["", "5"])
      expect(cashWords(cash({ walletUsd: "10", maxUsd: onSolana }), "base", typed).words).toBe(
        "Your cash is on Solana. Pick Solana to withdraw it.",
      );
    // $5 on Base and $8 on Solana: $7 fits on Solana in one withdrawal.
    const mostOnSolana = { ...spread, solana: "8.00" };
    expect(cashWords(cash({ walletUsd: "13", maxUsd: mostOnSolana }), "base", "7").words).toBe(
      "One withdrawal on Base can send up to $5. Pick Solana to send up to $8.",
    );
  });

  it("says when nothing can leave yet, and where their cash is", () => {
    const none = { base: "0.00", solana: "0.00", arbitrum: "0.00", monad: "0.00", polygon: "0.00" };
    expect(
      cashWords(cash({ walletUsd: "0", maxUsd: none, elsewhere: atApps }), "base", ""),
    ).toEqual({
      words:
        "No USDC in your wallet. $0.49 on Aave and $0.10 on Polymarket: ask Auni to move it back first.",
      over: false,
    });
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

  // One quoted before what lands was kept, with only its fee, said "$120 arrived" for $120 sent
  // of which the bridge kept $1.25 (review of 2026-11-25).
  it("never says the whole amount arrived when only the fee between networks is known", () => {
    const quotedBefore = (status: "running" | "done") => ({
      ...now(status),
      amountUsd: "120.00",
      details: { arrives: "In about a minute", fee: "$1.25" },
    });
    expect(sentWords(sent, quotedBefore("running"))).toEqual({
      title: "$120 on its way",
      lede: "Arrives in about a minute, less the $1.25 fee to move it between networks.",
    });
    const done = sentWords(sent, quotedBefore("done"));
    expect(done.title).toBe("$120 sent");
    expect(done.lede).toMatch(
      /^Reached your other wallet on Base at \d{1,2}:04[ap]m, less the \$1\.25 fee to move it between networks\.$/u,
    );
  });

  it("says it didn't go through, and why, once it failed", () => {
    expect(sentWords(sent, now("failed", "The network refused it. Nothing was sent."))).toEqual({
      title: "Withdrawal didn't go through",
      lede: "The network refused it. Nothing was sent.",
    });
  });
});
