import { NETWORK_KEYS, NETWORKS } from "@auni/shared";
import { describe, expect, it, vi } from "vitest";

import type { WalletAddresses } from "../apps/contract.ts";

import { networkFacts, systemPrompt, turnContext } from "./prompt.ts";

const brain = { computer: "a shell with no internet", models: "Some Lab's models" };

// No wallet, unless a test brings one.
const wallet = vi.hoisted(() => ({ addresses: { evm: null, solana: null } as WalletAddresses }));
vi.mock(import("../money/wallets.ts"), async (original) => ({
  ...(await original()),
  walletAddresses: async () => wallet.addresses,
}));

describe("systemPrompt", () => {
  it("describes the computer and models of the brain it runs on, and nothing of another's", async () => {
    const prompt = await systemPrompt(brain);
    expect(prompt).toContain("You have a computer (a shell with no internet)");
    expect(prompt).toContain("you can say Some Lab's models.");
    expect(prompt).toContain("with load_skill");
    expect(prompt).not.toMatch(/Claude|Anthropic|Linux VM/u);
    // The same words every turn, so the model's prompt cache serves every turn.
    expect(await systemPrompt(brain)).toBe(prompt);
  });

  it("says what an app adds only while the owner has it on", async () => {
    const guide = "Perps trade on Hyperliquid";
    expect(await systemPrompt(brain)).toContain(guide);
    process.env.APPS_OFF = "hyperliquid";
    try {
      expect(await systemPrompt(brain)).not.toContain(guide);
    } finally {
      delete process.env.APPS_OFF;
    }
    expect(await systemPrompt(brain)).toContain(guide);
  });

  it("tells the agent every network Auni watches, as the registry lists them", async () => {
    const prompt = await systemPrompt(brain);
    const watched = prompt.slice(
      prompt.indexOf("People add money on "),
      prompt.indexOf(", and Auni watches each"),
    );
    for (const key of NETWORK_KEYS) expect(watched).toContain(NETWORKS[key].name);
  });

  it("tells the agent who pays the gas, and never to ask for it ahead", async () => {
    const prompt = await systemPrompt(brain);
    expect(prompt).toContain((await networkFacts()).NETWORK_FEES);
    expect(prompt).toContain("never ask for gas ahead");
  });
});

describe("turnContext", () => {
  const baseOwner = {
    timeZone: "UTC",
    name: null as string | null,
    xHandle: null as string | null,
    profileSummary: null as string | null,
    profileSignals: null,
  };

  it("includes fenced owner personalization signals when present and omits them when empty", () => {
    const empty = turnContext({
      owner: baseOwner,
      placeContext: null,
      wallets: null,
      now: new Date("2026-10-30T00:00:00Z"),
    });
    expect(empty).not.toContain("# Their first take");
    expect(empty).not.toContain("owner_profile");
    expect(empty.endsWith("</system-reminder>")).toBe(true);

    const personalized = turnContext({
      owner: {
        ...baseOwner,
        name: "Jarrod",
        xHandle: "jarrodwatts",
        profileSummary: "Focuses on AI infrastructure and avoids leverage.",
        profileSignals: {
          refreshedAt: "2026-10-30T00:00:00Z",
          xBio: "Building local AI tools",
          xTopics: ["AI infrastructure", "DeFi"],
          watchedHoldings: [
            { symbol: "ETH", name: "Ethereum", usdValue: "5000.00", chain: "Ethereum" },
          ],
        },
      },
      placeContext: null,
      wallets: null,
      now: new Date("2026-10-30T00:00:00Z"),
    });
    expect(personalized).toContain("The owner's name: Jarrod.");
    expect(personalized).toContain("owner_profile");
    expect(personalized).toContain("AI infrastructure");
    expect(personalized).toContain("@jarrodwatts");
  });

  // A wallet brought with its EVM key alone was offered Jupiter to buy on Solana, which it can't.
  it("says the wallet has no Solana address, so nothing there is offered", () => {
    const evm = "0x00000000000000000000000000000000000000a1";
    const facts = (wallets: { evm: string | null; solana: string | null }) =>
      turnContext({
        owner: baseOwner,
        placeContext: null,
        wallets,
        now: new Date("2026-10-30T00:00:00Z"),
      });
    expect(facts({ evm, solana: null })).toContain(
      `Their Auni wallet: ${evm} (the same address on every EVM network). Money sent to these is theirs. This wallet has no Solana address yet, so nothing can move on Solana. One can be added in Settings, under Wallet. Until then, offer nothing there.`,
    );
    expect(facts({ evm, solana: "So1ana" })).toContain(
      `Their Auni wallet: ${evm} (the same address on every EVM network) and So1ana on Solana. Money sent to these is theirs.\n`,
    );
    expect(facts({ evm: null, solana: null })).not.toContain("Their Auni wallet");
  });
});

describe("Auni's reach for a wallet brought with its EVM key alone", () => {
  it("leaves Solana out of what it trades on, and says why", async () => {
    wallet.addresses = { evm: "0x00000000000000000000000000000000000000a1", solana: null };
    try {
      const prompt = await systemPrompt(brain);
      expect(prompt).toContain(
        "This wallet has no Solana address yet, so nothing can move on Solana. One can be added in Settings, under Wallet. So tokenized stocks trade on Monad alone (stock_trade), and tokens on EVM chains",
      );
      expect(prompt).not.toMatch(/solana_swap|send_solana_transaction|trade on Solana or Monad/u);
    } finally {
      wallet.addresses = { evm: null, solana: null };
    }
    expect(await systemPrompt(brain)).toContain("Tokenized stocks trade on Solana or Monad");
  });
});
