import { readFileSync } from "node:fs";

import { fundingQuoteWireSchema } from "@auni/shared";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { serve } from "../test/serve.ts";
import { fundingRouter } from "./funding.ts";

// The wallet's own address, which Relay's recorded quote (its app's fixtures) pays.
const WALLET = "0x1111111111111111111111111111111111111111";
const BROWSER_WALLET = "0x2222222222222222222222222222222222222222";

vi.mock("../money/wallets.ts", () => ({
  walletAddresses: async () => ({ evm: WALLET, solana: null }),
}));
const mon = vi.hoisted(() => ({ balance: 0n }));
vi.mock("../money/chains.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  publicClient: () => ({ getBalance: async () => mon.balance }),
}));

const url = serve(express().use("/funding", fundingRouter));
const recorded = readFileSync(
  new URL("../apps/relay/fixtures/quote-base-to-monad.json", import.meta.url),
  "utf8",
);

/** What core asked Relay for, with Relay answering `answer`: the recorded quote unless said. */
function relayAnswers(answer = recorded) {
  const asked = vi.fn((_url: string, _init?: RequestInit) => new Response(answer));
  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
    String(input).startsWith("https://api.relay.link")
      ? asked(String(input), init)
      : realFetch(input, init),
  );
  return asked;
}

const quote = (body: unknown) =>
  fetch(url("/funding/quote"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

afterEach(() => vi.restoreAllMocks());

describe("POST /funding/quote", () => {
  it("quotes USDC on Base to the wallet's own address on Monad, with MON for fees", async () => {
    const asked = relayAnswers();
    const response = await quote({ chainId: 8453, amountUsdc: "20", user: BROWSER_WALLET });
    expect(response.status).toBe(200);
    const wire = fundingQuoteWireSchema.parse(await response.json());
    expect(wire.by).toBe("Relay");
    expect(wire.steps.map(({ id }) => id)).toEqual(["approve", "deposit"]);
    expect(Number(wire.receiveMon)).toBeGreaterThan(1);
    const sent = JSON.parse(String(asked.mock.calls[0]![1]!.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({
      user: BROWSER_WALLET,
      recipient: WALLET,
      originChainId: 8453,
      destinationChainId: 143,
      amount: "20000000",
      topupGas: true,
      topupGasAmount: "1000000",
    });
  });

  it("asks for no MON once the wallet holds the 10 MON Add money asks for", async () => {
    try {
      const asked = relayAnswers();
      const sent = (call: number) =>
        JSON.parse(String(asked.mock.calls[call]![1]!.body)) as Record<string, unknown>;
      // 1 MON pays for about six moves: a dollar of the payment still comes as MON.
      mon.balance = 10n ** 18n;
      await quote({ chainId: 8453, amountUsdc: "20", user: BROWSER_WALLET });
      expect(sent(0)).toHaveProperty("topupGas", true);
      mon.balance = 10n * 10n ** 18n;
      await quote({ chainId: 8453, amountUsdc: "20", user: BROWSER_WALLET });
      expect(sent(1)).not.toHaveProperty("topupGas");
    } finally {
      mon.balance = 0n;
    }
  });

  it("refuses a recipient the browser names, and a chain it doesn't pay from", async () => {
    const asked = relayAnswers();
    const recipient = await quote({
      chainId: 8453,
      amountUsdc: "20",
      user: BROWSER_WALLET,
      recipient: BROWSER_WALLET,
    });
    expect(recipient.status).toBe(400);
    const monad = await quote({ chainId: 143, amountUsdc: "20", user: BROWSER_WALLET });
    expect(await monad.json()).toEqual({ error: "chain_not_offered" });
    expect((await quote({ chainId: 8453, amountUsdc: "0", user: BROWSER_WALLET })).status).toBe(
      400,
    );
    expect(asked).not.toHaveBeenCalled();
  });

  it("refuses Relay's quote when it pays anyone but the wallet", async () => {
    const answer = JSON.parse(recorded) as { details: { recipient: string } };
    answer.details.recipient = BROWSER_WALLET;
    relayAnswers(JSON.stringify(answer));
    const response = await quote({ chainId: 8453, amountUsdc: "20", user: BROWSER_WALLET });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: "quote_refused" });
  });
});
