import { readFileSync } from "node:fs";

import { NETWORKS, type EvmChainKey } from "@auni/shared";
import { getAddress, type Address, type Hex, type Log } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { approval, effectLines } from "../../money/effect.ts";
import { sendEvmTransaction } from "../../money/recipes/evm.ts";
import {
  simulateEffect,
  tokenNames,
  walletEffect,
  type SimulatedEffect,
} from "../../money/wallet-effect.ts";
import { addresses, reads, ROUTER, ROUTER_CHAINS } from "./reader.ts";

// KyberSwap's reader, proved on what its API and a chain really answered (fixtures/): a swap
// its API built, as a simulation of it on a fork of Base saw it.

vi.mock("../../money/wallet-effect.ts", async (original) => ({
  ...(await original()),
  simulateEffect: vi.fn(),
  tokenNames: vi.fn(),
}));
vi.mock("../../money/app-logo.ts", () => ({ appLogo: async () => null }));
vi.mock("../../money/wallets.ts", async (original) => ({
  ...(await original()),
  evmAddress: async () => SWAP.owner,
  paysOwnGas: async () => false,
}));

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8")) as T;

const ROUTERS = fixture<{
  answers: Record<string, { data: { routerAddress: string } }>;
}>("routers.json");
const SWAP = fixture<{
  owner: Address;
  call: { to: Address; data: Hex; value: Hex };
  simulated: { logs: Log[] };
}>("swap-base.json");

/** The recorded swap, as the simulation core runs before a card would read it. */
const recorded: SimulatedEffect = {
  ...walletEffect(SWAP.simulated.logs, SWAP.owner),
  blind: false,
  logs: SWAP.simulated.logs,
};
const USDC = getAddress(NETWORKS.base.usdc);
const ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const call = { ...SWAP.call, value: BigInt(SWAP.call.value) };

beforeEach(() => {
  vi.mocked(simulateEffect).mockResolvedValue(recorded);
  vi.mocked(tokenNames).mockResolvedValue(
    new Map([
      [USDC, { symbol: "USDC", decimals: 6, usd: 1 }],
      [ETH, { symbol: "ETH", decimals: 18, usd: 2077 }],
    ]),
  );
});

describe("KyberSwap's router", () => {
  it("is the address KyberSwap's API names on each chain the reader knows it on", () => {
    // KyberSwap calls BNB Chain "bsc".
    const recordedOn = Object.keys(ROUTERS.answers).map((chain) =>
      chain === "bsc" ? "bnb" : chain,
    );
    expect(recordedOn.toSorted()).toEqual([...ROUTER_CHAINS].toSorted());
    for (const { data } of Object.values(ROUTERS.answers))
      expect(getAddress(data.routerAddress)).toBe(ROUTER);
  });

  it("is named only on those chains", async () => {
    expect((await addresses("base")).get(ROUTER.toLowerCase())).toBe("KyberSwap's router");
    expect((await addresses("ink" as EvmChainKey)).size).toBe(0);
  });
});

describe("a swap Claude built through KyberSwap", () => {
  it("reads as a swap, saying how far the price may slip before it fails", () => {
    // The recorded simulation sold 0.01 ETH and got USDC, as KyberSwap's API built it.
    expect(recorded.out).toEqual([{ token: ETH, amount: 10_000_000_000_000_000n }]);
    expect(recorded.in.map(({ token }) => getAddress(token))).toEqual([USDC]);
    expect(reads("base", [call], recorded)).toEqual({
      verb: "swap",
      // Built with slippageTolerance 100: 1% under what the API said, a hair off what the fork got.
      finePrint:
        "If the price slips more than 1% before it goes through, the swap fails and only the network fee is spent.",
    });
  });

  it("says no fine print it can't work out, and reads nothing but a swap", () => {
    expect(reads("base", [call], { ...recorded, in: [] })).toEqual({ verb: "swap" });
    expect(reads("base", [{ ...call, data: "0x095ea7b3" }], recorded)).toBeNull();
  });

  /** The card for the recorded swap sent to `to`, after `first`, with the agent's own hint. */
  const describeAt = (
    to: string,
    first: readonly { to: string; data: string }[] = [],
    app?: { name: string; site: string; verb: string },
  ) =>
    sendEvmTransaction.describe(
      {
        chain: "base",
        calls: [...first, { to, data: SWAP.call.data, value: "10000000000000000" }],
        summary: "Swap 0.01 ETH for USDC",
        ...(app ? { app } : {}),
      },
      {},
    );
  const ELSEWHERE = "0x2222222222222222222222222222222222222222";

  it("wears KyberSwap's name and words, with every figure the agent's own card has", async () => {
    const read = await describeAt(ROUTER);
    // The same swap at a contract no app knows, the agent naming KyberSwap itself: nothing
    // checks that name, so it is the card a reader replaces.
    const plain = await describeAt(ELSEWHERE, [], {
      name: "KyberSwap",
      site: "kyberswap.com",
      verb: "swap",
    });
    // The swap's layout names it from what the simulation saw leave.
    expect(read.card?.title).toBe("Sell ETH");
    expect(read.card?.context).toBe("KyberSwap on Base");
    expect(read.card?.finePrint).toBe(
      "If the price slips more than 1% before it goes through, the swap fails and only the network fee is spent. It goes through KyberSwap's router (0x6131…37b5).",
    );
    expect(plain.card?.finePrint).toBe("It goes through 0x2222…2222.");
    // What moves, the dollars, every figure, and tap or proof are the simulation's alone.
    expect(read.card?.figures).toEqual(plain.card?.figures);
    expect(read.card?.figures.map(({ label }) => label)).toEqual([
      "You sell",
      "You get, about",
      "Price",
      "Vs market",
    ]);
    expect(read.effect).toEqual(plain.effect);
    expect(effectLines(read.effect)).toEqual(effectLines(plain.effect));
    expect(read.amountUsd).toBe(plain.amountUsd);
    expect(approval(read.effect, [])).toEqual(approval(plain.effect, []));
  });

  it("names what it sells and gets as the card with no app at all does", async () => {
    const read = await describeAt(ROUTER);
    const bare = await describeAt(ELSEWHERE);
    const figure = (card: typeof read, label: string) =>
      card.card?.figures.find((each) => each.label === label)?.value;
    for (const label of ["You sell", "You get, about"])
      expect(figure(read, label), label).toBe(figure(bare, label));
    expect(read.effect).toEqual(bare.effect);
  });

  it("is the plain card when the batch also pays someone else", async () => {
    const stranger = "9999999999999999999999999999999999999999".padStart(64, "0");
    const card = await describeAt(ROUTER, [
      { to: USDC, data: `0xa9059cbb${stranger}${1n.toString(16).padStart(64, "0")}` },
    ]);
    expect(card.card?.context).toBe("On Base");
    expect(JSON.stringify(card)).not.toContain("KyberSwap");
  });
});
