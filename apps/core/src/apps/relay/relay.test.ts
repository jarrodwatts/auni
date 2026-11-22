import { readFileSync } from "node:fs";

import { NETWORKS } from "@auni/shared";
import { encodeFunctionData, erc20Abi, parseAbi, type Address } from "viem";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkedQuote as held, PayInRefused, type PayInRequest } from "../../money/pay-in.ts";
import { answered, deposit, DEPOSITORY, quote, status } from "./relay.ts";

// Relay's answers as it gave them, each read by this app and then held to its request by
// core's own check, as a live quote is (money/pay-in.ts).
const checkedQuote = (request: PayInRequest, answer: unknown) =>
  held(request, { name: "Relay", depository: DEPOSITORY, deposit }, answered(answer));

// Recorded 2026-11-06: 20 USDC on Base to USDC on Monad, a dollar of it as MON.
const recorded = () =>
  JSON.parse(
    readFileSync(new URL("./fixtures/quote-base-to-monad.json", import.meta.url), "utf8"),
  ) as {
    requestId: string;
    steps: { id: string; kind: string; items: { data: Record<string, unknown> }[] }[];
    details: Record<string, unknown>;
  };

const request: PayInRequest = {
  user: "0x2222222222222222222222222222222222222222",
  recipient: "0x1111111111111111111111111111111111111111",
  from: { chain: "base", token: NETWORKS.base.usdc as Address },
  to: { chain: "monad", token: NETWORKS.monad.usdc },
  amount: 20_000_000n,
  topUpUsd: 1,
};

const OTHER = "0x3333333333333333333333333333333333333333";
const depositAbi = parseAbi([
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
]);

/** The recorded answer with one step's call changed. */
function withCall(step: "approve" | "deposit", change: Record<string, unknown>) {
  const answer = recorded();
  const found = answer.steps.find(({ id }) => id === step)!;
  found.items[0]!.data = { ...found.items[0]!.data, ...change };
  return answer;
}

describe("Relay's quote, checked", () => {
  it("hands on Relay's two steps, the approval and the deposit, and what arrives", () => {
    const quote = checkedQuote(request, recorded());
    expect(quote.by).toBe("Relay");
    expect(quote.steps.map(({ id, call }) => [id, call.to, call.chainId])).toEqual([
      ["approve", NETWORKS.base.usdc, 8453],
      ["deposit", expect.stringMatching(new RegExp(DEPOSITORY, "iu")), 8453],
    ]);
    expect(quote.requestId).toBe(recorded().requestId);
    expect(quote.out).toBeGreaterThan(18_000_000n);
    expect(quote.gas).toBeGreaterThan(10n ** 18n);
  });

  it("refuses a quote that pays someone else", () => {
    const answer = recorded();
    answer.details.recipient = OTHER;
    expect(() => checkedQuote(request, answer)).toThrow(/pays someone else/u);
  });

  it("refuses an approval of anyone but Relay's depository, or of more than the amount", () => {
    const approve = (spender: Address, amount: bigint) =>
      withCall("approve", {
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [spender, amount],
        }),
      });
    expect(() => checkedQuote(request, approve(OTHER, request.amount))).toThrow(PayInRefused);
    expect(() => checkedQuote(request, approve(DEPOSITORY, 2n ** 255n))).toThrow(
      /approves something other/u,
    );
    // A transfer to the token's own address is no approval.
    const transfer = withCall("approve", {
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [OTHER, request.amount],
      }),
    });
    expect(() => checkedQuote(request, transfer)).toThrow(PayInRefused);
  });

  it("refuses a deposit anywhere but the depository, or for another amount or sender", () => {
    expect(() => checkedQuote(request, withCall("deposit", { to: OTHER }))).toThrow(
      /neither the token nor Relay/u,
    );
    const deposit = (depositor: Address, amount: bigint) =>
      withCall("deposit", {
        data: encodeFunctionData({
          abi: depositAbi,
          functionName: "depositErc20",
          args: [
            depositor,
            request.from.token as Address,
            amount,
            recorded().requestId as `0x${string}`,
          ],
        }),
      });
    expect(() => checkedQuote(request, deposit(request.user, request.amount + 1n))).toThrow(
      /deposits something other/u,
    );
    expect(() => checkedQuote(request, deposit(OTHER, request.amount))).toThrow(
      /deposits something other/u,
    );
    expect(() => checkedQuote(request, withCall("deposit", { data: "0xdeadbeef" }))).toThrow(
      /can't read/u,
    );
  });

  it("refuses a step that sends coin, runs on another chain, or isn't a transaction", () => {
    expect(() => checkedQuote(request, withCall("deposit", { value: "1" }))).toThrow(/sends coin/u);
    expect(() => checkedQuote(request, withCall("approve", { chainId: 1 }))).toThrow(
      /another chain/u,
    );
    const signature = recorded();
    signature.steps[0]!.kind = "signature";
    expect(() => checkedQuote(request, signature)).toThrow(/"signature" step/u);
  });

  it("refuses a quote that never deposits", () => {
    const answer = recorded();
    answer.steps = answer.steps.filter(({ id }) => id !== "deposit");
    expect(() => checkedQuote(request, answer)).toThrow(/deposit once/u);
  });
});

describe("Relay's quote for SOL", () => {
  // Recorded 2026-11-06: $1 of Monad USDC to SOL (sender 0x…dEaD, recipient Solana's docs'
  // example address).
  const answer = () =>
    JSON.parse(
      readFileSync(new URL("./fixtures/quote-monad-to-sol.json", import.meta.url), "utf8"),
    ) as { details: { currencyOut: { currency: Record<string, unknown> } } };
  const sol: PayInRequest = {
    user: "0x000000000000000000000000000000000000dEaD",
    recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    from: { chain: "monad", token: NETWORKS.monad.usdc },
    to: { chain: "solana", token: "native" },
    amount: 1_000_000n,
  };

  it("is read as SOL on Solana by core's names, and passes core's check", () => {
    expect(answered(answer()).pays).toEqual({
      recipient: sol.recipient,
      chain: "solana",
      token: "native",
    });
    const quote = checkedQuote(sol, answer());
    expect(quote.steps.map(({ id }) => id)).toEqual(["approve", "deposit"]);
    expect(quote.least).toBe(10_411_112n);
  });

  it("is refused when it pays out anything but SOL there", () => {
    const usdc = answer();
    usdc.details.currencyOut.currency.address = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    expect(() => checkedQuote(sol, usdc)).toThrow(/pays out something else/u);
    const elsewhere = answer();
    elsewhere.details.currencyOut.currency.chainId = 8453;
    expect(() => checkedQuote(sol, elsewhere)).toThrow(/pays out something else/u);
  });
});

// The coin an EVM chain's fees are paid in, delivered to the wallet's own address there
// (money/fee-coin.ts). Recorded 2026-11-13 for an address that holds nothing.
describe("Relay's quote for a chain's coin", () => {
  type Recorded = { steps: { id: string; items: { data: Record<string, unknown> }[] }[] };
  const answer = (name: string) =>
    JSON.parse(
      readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
    ) as Recorded;
  const user: Address = "0x2222222222222222222222222222222222222222";
  const to = { chain: "arbitrum", token: "native" } as const;
  // 30 MON, sent as the coin itself.
  const withCoin: PayInRequest = {
    user,
    recipient: user,
    from: { chain: "monad", token: "native" },
    to,
    amount: 30n * 10n ** 18n,
  };
  const coin = () => answer("quote-monad-coin-to-arbitrum-coin");

  it("paid with USDC is an exact approval and a deposit, landing ETH on Arbitrum", () => {
    const withUsdc: PayInRequest = {
      ...withCoin,
      from: { chain: "monad", token: NETWORKS.monad.usdc as Address },
      amount: 1_000_000n,
    };
    const quote = checkedQuote(withUsdc, answer("quote-monad-usdc-to-arbitrum-coin"));
    expect(quote.steps.map(({ id, call }) => [id, call.value])).toEqual([
      ["approve", 0n],
      ["deposit", 0n],
    ]);
    expect(quote.least).toBe(477_924_917_120_163n);
  });

  it("paid with the chain's own coin is one deposit that carries exactly the amount", () => {
    const quote = checkedQuote(withCoin, coin());
    expect(quote.steps.map(({ id, call }) => [id, call.to.toLowerCase(), call.value])).toEqual([
      ["deposit", DEPOSITORY, 30n * 10n ** 18n],
    ]);
    expect(deposit(quote.steps[0]!.call.data, quote.steps[0]!.call.value)).toEqual({
      depositor: user,
      token: "native",
      amount: 30n * 10n ** 18n,
    });
    expect(quote.least).toBe(225_861_237_566_247n);
  });

  it("refuses a coin deposit that carries another amount, goes elsewhere or is for someone else", () => {
    const changed = (change: Record<string, unknown>) => {
      const quote = coin();
      const [step] = quote.steps;
      step!.items[0]!.data = { ...step!.items[0]!.data, ...change };
      return quote;
    };
    const native = parseAbi(["function depositNative(address depositor, bytes32 id) payable"]);
    const forSomeoneElse = encodeFunctionData({
      abi: native,
      functionName: "depositNative",
      args: [OTHER, `0x${"00".repeat(32)}`],
    });
    expect(() => checkedQuote(withCoin, changed({ value: "30000000000000000001" }))).toThrow(
      /carries something other than the amount/u,
    );
    expect(() => checkedQuote(withCoin, changed({ value: "0" }))).toThrow(PayInRefused);
    expect(() => checkedQuote(withCoin, changed({ to: OTHER }))).toThrow(PayInRefused);
    expect(() => checkedQuote(withCoin, changed({ data: forSomeoneElse }))).toThrow(
      /deposits something other/u,
    );
    // A request for a token is never answered by a deposit of coin, nor the other way.
    const usdc = { ...withCoin, from: { chain: "monad", token: NETWORKS.monad.usdc as Address } };
    expect(() =>
      checkedQuote({ ...usdc, amount: withCoin.amount } as PayInRequest, coin()),
    ).toThrow(PayInRefused);
  });
});

describe("asking Relay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RELAY_API_KEY;
  });
  const answering = (body: unknown, init?: ResponseInit) =>
    vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(JSON.stringify(body), init));
  const id = `0x${"ab".repeat(32)}` as const;

  it("asks in Relay's own names for the chains and SOL, with its key only when one is set", async () => {
    const asked = answering(recorded());
    await quote({ ...request, to: { chain: "solana", token: "native" } });
    const [url, init] = asked.mock.calls[0]!;
    expect(url).toBe("https://api.relay.link/quote/v2");
    expect(JSON.parse(String(init!.body))).toMatchObject({
      originChainId: 8453,
      originCurrency: NETWORKS.base.usdc,
      destinationChainId: 792_703_809,
      destinationCurrency: "11111111111111111111111111111111",
      amount: "20000000",
      topupGasAmount: "1000000",
    });
    expect(init!.headers).not.toHaveProperty("x-api-key");
    process.env.RELAY_API_KEY = "a-key";
    await quote(request);
    expect(asked.mock.calls[1]![1]!.headers).toMatchObject({ "x-api-key": "a-key" });
  });

  it("refuses with Relay's own words when it turns the ask away, or answers what can't be read", async () => {
    answering({ message: "Amount is too small" }, { status: 400 });
    await expect(quote(request)).rejects.toThrow(new PayInRefused("Amount is too small"));
    answering({ steps: "none" });
    await expect(quote(request)).rejects.toThrow("a quote Auni can't read");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await expect(quote(request)).rejects.toThrow("Relay didn't answer.");
  });

  it("is final only on success, a refund, or a failure Relay won't refund", async () => {
    const paid = `0x${"cd".repeat(32)}`;
    answering({ status: "success", txHashes: [paid] });
    expect(await status(id)).toEqual({ status: "success", paidIn: [paid] });
    answering({ status: "refund", txHashes: [paid] });
    expect(await status(id)).toEqual({ status: "refunded", paidIn: [] });
    answering({ status: "failure" });
    expect((await status(id)).status).toBe("pending");
    answering({ status: "failure", refundFailReason: "AMOUNT_TOO_LOW_TO_REFUND" });
    expect((await status(id)).status).toBe("failed");
    answering({ status: "waiting" });
    expect((await status(id)).status).toBe("pending");
  });

  it("takes a success for one only once Relay names what paid the recipient", async () => {
    answering({ status: "success" });
    expect(await status(id)).toEqual({ status: "pending", paidIn: [] });
    answering({ status: "success", txHashes: [] });
    expect((await status(id)).status).toBe("pending");
  });
});
