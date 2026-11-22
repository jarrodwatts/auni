import { NETWORKS } from "@auni/shared";
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PayIn } from "../apps/contract.ts";
import {
  checkedQuote,
  payInQuote,
  PayInRefused,
  payInStanding,
  type PayInAnswer,
  type PayInRequest,
} from "./pay-in.ts";

// The rule is core's and holds whichever app fills the role: here a made-up service, Carry,
// with a depository and a deposit call of its own. The app Auni ships proves the same against
// its service's recorded answers, in its own folder.
const DEPOSITORY = getAddress("0x00000000000000000000000000000000000de905");
const OTHER: Address = "0x3333333333333333333333333333333333333333";
const abi = parseAbi(["function deposit(address from, address token, uint256 amount)"]);
const carry = {
  depository: DEPOSITORY,
  deposit(data: Hex) {
    const [depositor, token, amount] = decodeFunctionData({ abi, data }).args;
    return { depositor, token, amount };
  },
  quote: vi.fn(),
  status: vi.fn(),
} satisfies PayIn;
vi.mock(import("../apps/registry.ts"), async (original) => ({
  ...(await original()),
  filling: (() => [
    { about: { id: "carry", name: "Carry" }, part: carry },
    { about: { id: "second", name: "Second" }, part: { ...carry, quote: vi.fn() } },
  ]) as never,
}));

const request: PayInRequest = {
  user: "0x2222222222222222222222222222222222222222",
  recipient: "0x1111111111111111111111111111111111111111",
  from: { chain: "base", token: NETWORKS.base.usdc },
  to: { chain: "monad", token: NETWORKS.monad.usdc },
  amount: 20_000_000n,
};
const id = `0x${"ab".repeat(32)}` as const;
const step = (name: string, to: string, data: Hex) => ({
  id: name,
  kind: "transaction",
  requestId: id,
  calls: [{ chainId: 8453, to, data, value: 0n }],
});
const approve = (spender: Address, amount: bigint) =>
  step(
    "approve",
    request.from.token,
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  );
const deposit = (from: Address, token: Address | "native", amount: bigint) =>
  step(
    "deposit",
    DEPOSITORY,
    encodeFunctionData({ abi, functionName: "deposit", args: [from, token as Address, amount] }),
  );
const good = (): PayInAnswer => ({
  steps: [
    approve(DEPOSITORY, request.amount),
    deposit(request.user, request.from.token, request.amount),
  ],
  pays: { recipient: request.recipient, ...request.to },
  out: 19_900_000n,
  least: 19_800_000n,
});
const check = (answer: PayInAnswer) => checkedQuote(request, { name: "Carry", ...carry }, answer);

beforeEach(() => vi.clearAllMocks());

describe("a pay-in quote, checked", () => {
  it("hands on an exact approval of the depository and one deposit of the amount, under the service's name", () => {
    expect(check(good())).toMatchObject({
      by: "Carry",
      requestId: id,
      steps: [
        { id: "approve", call: { chainId: 8453, to: NETWORKS.base.usdc, value: 0n } },
        { id: "deposit", call: { chainId: 8453, value: 0n } },
      ],
      out: 19_900_000n,
      least: 19_800_000n,
    });
  });

  it("refuses one that pays anyone or anything but what was asked", () => {
    const pays = (change: Partial<PayInAnswer["pays"]>) =>
      check({ ...good(), pays: { ...good().pays, ...change } });
    expect(() => pays({ recipient: OTHER })).toThrow("Carry's quote pays someone else");
    expect(() => pays({ chain: "base" })).toThrow(/pays out something else/u);
    expect(() => pays({ token: OTHER })).toThrow(/pays out something else/u);
    // A chain's own coin is no token at an address, and no address is the coin.
    expect(() => pays({ token: "native" })).toThrow(/pays out something else/u);
  });

  it("refuses an approval of anyone but the depository, of another amount, or that is no approval", () => {
    const first = (changed: PayInAnswer["steps"][number]) =>
      check({ ...good(), steps: [changed, good().steps[1]!] });
    expect(() => first(approve(OTHER, request.amount))).toThrow(PayInRefused);
    expect(() => first(approve(DEPOSITORY, 2n ** 255n))).toThrow(
      "approves something other than the amount, to Carry",
    );
    const transfer = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [OTHER, request.amount],
    });
    expect(() => first(step("approve", request.from.token, transfer))).toThrow(PayInRefused);
  });

  it("refuses a deposit anywhere else, for another sender, token or amount, or that the app can't read", () => {
    const last = (changed: PayInAnswer["steps"][number]) =>
      check({ ...good(), steps: [good().steps[0]!, changed] });
    const { user, from, amount } = request;
    expect(() =>
      last({ ...good().steps[1]!, calls: [{ ...good().steps[1]!.calls[0]!, to: OTHER }] }),
    ).toThrow("neither the token nor Carry");
    expect(() => last(deposit(OTHER, from.token, amount))).toThrow(/deposits something other/u);
    expect(() => last(deposit(user, OTHER, amount))).toThrow(/deposits something other/u);
    expect(() => last(deposit(user, from.token, amount + 1n))).toThrow(/deposits something other/u);
    expect(() => last(step("deposit", DEPOSITORY, "0xdeadbeef"))).toThrow(/can't read/u);
  });

  it("refuses a step that sends coin, runs on another chain, mixes requests or isn't one transaction", () => {
    const withCall = (change: Partial<PayInAnswer["steps"][number]["calls"][number]>) => {
      const [first, last] = good().steps;
      return check({
        ...good(),
        steps: [first!, { ...last!, calls: [{ ...last!.calls[0]!, ...change }] }],
      });
    };
    expect(() => withCall({ value: 1n })).toThrow(/sends coin/u);
    expect(() => withCall({ chainId: 1 })).toThrow(/another chain/u);
    const [first, last] = good().steps;
    expect(() => check({ ...good(), steps: [first!, { ...last!, requestId: "0x01" }] })).toThrow(
      /mixes requests/u,
    );
    expect(() => check({ ...good(), steps: [{ ...first!, kind: "signature" }, last!] })).toThrow(
      /"signature" step/u,
    );
    expect(() => check({ ...good(), steps: [first!, { ...last!, calls: [] }] })).toThrow(
      PayInRefused,
    );
  });

  it("refuses a quote with no deposit, two, or anything after it", () => {
    const [first, last] = good().steps;
    expect(() => check({ ...good(), steps: [] })).toThrow(/has no steps/u);
    expect(() => check({ ...good(), steps: [first!] })).toThrow(/deposit once/u);
    expect(() => check({ ...good(), steps: [last!, last!] })).toThrow(/deposit once/u);
    expect(() => check({ ...good(), steps: [last!, first!] })).toThrow(/end in its deposit/u);
  });
});

describe("paying in", () => {
  it("asks the first app in the role, and hands on only what its answer passes the check as", async () => {
    carry.quote.mockResolvedValue(good());
    expect((await payInQuote(request)).by).toBe("Carry");
    expect(carry.quote).toHaveBeenCalledWith(request);
    carry.quote.mockResolvedValue({ ...good(), pays: { ...good().pays, recipient: OTHER } });
    await expect(payInQuote(request)).rejects.toThrow(PayInRefused);
    carry.status.mockResolvedValue({ status: "refunded", paidIn: [] });
    expect((await payInStanding(id)).status).toBe("refunded");
  });

  it('takes a chain\'s own coin only by the name "native", never as the zero address', async () => {
    const coin = { ...request, from: { chain: "base", token: `0x${"0".repeat(40)}` } } as const;
    await expect(payInQuote(coin)).rejects.toThrow('named "native"');
    expect(carry.quote).not.toHaveBeenCalled();
  });
});
