import { readFileSync } from "node:fs";

import { NETWORKS } from "@auni/shared";
import { decodeFunctionData, erc20Abi, getAddress, parseUnits, type Address } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { burnCalls, credited, forwardHook, forwardingFee, TOKEN_MESSENGER } from "./cctp.ts";

/** What was recorded from Circle, Arbitrum and Hyperliquid (see each fixture's `from`). */
const recorded = <Answer>(name: string) =>
  (
    JSON.parse(readFileSync(new URL(`fixtures/cctp/${name}.json`, import.meta.url), "utf8")) as {
      readonly answer: Answer;
    }
  ).answer;

// A real deposit somebody made on 2026-11-13: 2,000 USDC burned on Arbitrum for their own
// Hyperliquid account, which was credited $1,999.80 seven seconds later.
const DEPOSIT = recorded<{
  readonly transaction: { readonly hash: string; readonly to: string; readonly input: string };
  readonly burnedAt: number;
  readonly account: Address;
  readonly circle: { messages: { forwardState: string }[] };
  readonly ledger: { time: number; hash: string; delta: Record<string, unknown> }[];
  readonly before: { readonly spotUsdc: string; readonly auniFreeUsd: number };
  readonly after: { readonly spotUsdc: string; readonly auniFreeUsd: number };
}>("deposit");
const FEES = recorded<object[]>("fees");
const AMOUNT = parseUnits("2000", 6);
const FEE = 200_000n;

// Circle's API and Hyperliquid's ledger, stood in for over fetch; each test sets what they say.
const world = {
  fees: FEES as unknown,
  circle: DEPOSIT.circle as unknown,
  ledger: DEPOSIT.ledger,
};

beforeEach(() => {
  Object.assign(world, { fees: FEES, circle: DEPOSIT.circle, ledger: DEPOSIT.ledger });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { body: string }) => {
      if (String(url).includes("/burn/USDC/fees/3/19?forward=true&hyperCoreDeposit=true"))
        return Response.json(world.fees);
      if (String(url).includes(`/messages/3?transactionHash=${DEPOSIT.transaction.hash}`))
        return world.circle === null
          ? Response.json({ code: 404, message: "Messages not found" }, { status: 404 })
          : Response.json(world.circle);
      const body = JSON.parse(init!.body) as { type: string; startTime: number };
      if (body.type !== "userNonFundingLedgerUpdates") throw new Error(`no answer for ${url}`);
      return Response.json(world.ledger.filter(({ time }) => time >= body.startTime));
    }),
  );
});

describe("a deposit by CCTP", () => {
  it("burns with the very bytes of a real deposit that Hyperliquid credited", () => {
    const [approval, burn] = burnCalls(DEPOSIT.account, AMOUNT, FEE);
    expect(getAddress(burn!.to)).toBe(getAddress(DEPOSIT.transaction.to));
    expect(burn!.to).toBe(TOKEN_MESSENGER);
    // Same amount, same account, same fee: the same call, byte for byte.
    expect(burn!.data).toBe(DEPOSIT.transaction.input);
    // Before it, the messenger is approved for exactly what it burns, and nothing else is.
    expect(approval).toMatchObject({ to: NETWORKS.arbitrum.usdc, setup: true });
    expect(decodeFunctionData({ abi: erc20Abi, data: approval!.data as `0x${string}` })).toEqual({
      functionName: "approve",
      args: [TOKEN_MESSENGER, AMOUNT],
    });
    expect(burnCalls(DEPOSIT.account, AMOUNT, FEE)).toHaveLength(2);
  });

  it("names the owner's own account, and its perps balance, in what the forwarder reads", () => {
    // "cctp-forward" in 24 bytes, version 0, 24 bytes to follow, the account, balance 0.
    expect(forwardHook("0x5fa99df1da5bd31de8897b02e4272580560d6270")).toBe(
      "0x636374702d666f727761726400000000000000000000000000000000000000185fa99df1da5bd31de8897b02e4272580560d627000000000",
    );
  });

  it("quotes the fee Circle names for carrying it into Hyperliquid", async () => {
    expect(await forwardingFee(AMOUNT)).toBe(FEE);
    // A share of the amount on top, if Circle ever charges one for a fast burn: rounded up.
    world.fees = [
      { finalityThreshold: 1000, minimumFee: 1.3, forwardFee: { low: 1, med: 2, high: 200_000 } },
    ];
    expect(await forwardingFee(parseUnits("10", 6))).toBe(200_000n + 1_300n);
    expect(await forwardingFee(1n)).toBe(200_001n);
  });

  it("makes no card when Circle quotes no fee for it", async () => {
    world.fees = [
      { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 1, med: 1, high: 1 } },
    ];
    await expect(forwardingFee(AMOUNT)).rejects.toThrow("Circle did not quote a fee");
  });
});

describe("a deposit by CCTP landing", () => {
  const sent = {
    hash: DEPOSIT.transaction.hash,
    owner: DEPOSIT.account,
    amount: AMOUNT,
    since: DEPOSIT.burnedAt - 2_000,
  };
  const [credit] = DEPOSIT.ledger;

  it("has landed once Circle says this burn was carried on and the ledger shows its credit", async () => {
    // $2,000.00 less the $0.20 Circle says it kept, from Circle's deposit wallet to the owner.
    expect(await credited(sent)).toEqual({ delivered: credit!.hash });
  });

  it("waits while Circle has not seen the burn, or has not carried it on", async () => {
    world.circle = null;
    expect(await credited(sent)).toBeNull();
    world.circle = { messages: [{ ...DEPOSIT.circle.messages[0], forwardState: "PENDING" }] };
    expect(await credited(sent)).toBeNull();
  });

  it("waits while Hyperliquid's ledger does not show the credit", async () => {
    world.ledger = [];
    expect(await credited(sent)).toBeNull();
  });

  it("takes no other line of the ledger for its credit", async () => {
    const other = (delta: object) => [{ ...credit!, delta: { ...credit!.delta, ...delta } }];
    // Another amount, another account's, a plain deposit, or one from anybody else.
    world.ledger = other({ amount: "1999.7" });
    expect(await credited(sent)).toBeNull();
    world.ledger = other({ destination: "0x00000000000000000000000000000000000000a1" });
    expect(await credited(sent)).toBeNull();
    world.ledger = other({ type: "deposit" });
    expect(await credited(sent)).toBeNull();
    world.ledger = other({ user: "0x00000000000000000000000000000000000000a1" });
    expect(await credited(sent)).toBeNull();
    // Nor a credit from before the move began: an earlier deposit of the same amount.
    world.ledger = DEPOSIT.ledger;
    expect(await credited({ ...sent, since: credit!.time + 1 })).toBeNull();
  });

  // What the open question of wave 4 came to: the credit is free cash as Auni counts it.
  it("was recorded raising the account's free cash by what was sent less the fee", () => {
    expect(DEPOSIT.before.spotUsdc).toBe("297.6");
    expect(DEPOSIT.after.spotUsdc).toBe("2297.4");
    expect(DEPOSIT.after.auniFreeUsd - DEPOSIT.before.auniFreeUsd).toBeCloseTo(1999.8, 6);
  });
});
