import { readFileSync } from "node:fs";

import { NETWORKS } from "@auni/shared";
import { decodeFunctionData, getAddress, pad, parseAbi, parseUnits } from "viem";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { publicClient } from "../../money/chains.ts";
import { usdLabel } from "../../money/format.ts";
import { erc20Calls, holdsToCard } from "../../test/held-to-card.ts";
import { OWNER } from "../../test/wallets.ts";
import { FORWARDER, forwardHook, TOKEN_MESSENGER } from "./cctp.ts";
import { hyperliquidDeposit } from "./transfers.ts";

const { answer: FEES } = JSON.parse(
  readFileSync(new URL("fixtures/cctp/fees.json", import.meta.url), "utf8"),
) as { readonly answer: { forwardFee: Record<string, number> }[] };

const messengerAbi = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

const world = vi.hoisted(() => ({ arbitrumUsdc: 0n, forwardFee: 200_000 }));

/** Circle's fee API as it answered, with the forwarding fee the world sets; the wallet holds $100. */
function world_() {
  Object.assign(world, { arbitrumUsdc: parseUnits("100", 6), forwardFee: 200_000 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!String(url).includes("/burn/USDC/fees/3/19?forward=true&hyperCoreDeposit=true"))
        throw new Error(`The drill's world has no answer for ${url}`);
      const fee = { low: world.forwardFee, med: world.forwardFee, high: world.forwardFee };
      return Response.json(FEES.map((quoted) => ({ ...quoted, forwardFee: fee })));
    }),
  );
  vi.spyOn(publicClient("arbitrum"), "readContract").mockImplementation(
    async () => world.arbitrumUsdc as never,
  );
}

holdsToCard("hyperliquid_deposit", {
  world: world_,
  asShown: { "$20 from Arbitrum": { amountUsd: 20 }, "the least it carries, $1": { amountUsd: 1 } },
  paysAsShown(signed, card) {
    const amount = parseUnits(card.amountUsd, 6);
    // One transaction on Arbitrum, of two calls, and nothing signed besides.
    expect(signed.typed).toEqual([]);
    expect(signed.solana).toEqual([]);
    expect(signed.evm).toHaveLength(1);
    const [{ chainId, txs }] = signed.evm as [(typeof signed.evm)[number]];
    expect(chainId).toBe(NETWORKS.arbitrum.viem.id);
    expect(txs).toHaveLength(2);
    // Circle's messenger may take exactly the card's amount, which the burn uses up: nobody
    // else is approved for anything, and no USDC is transferred to anyone.
    expect(erc20Calls(signed)).toEqual([
      {
        chainId,
        token: getAddress(NETWORKS.arbitrum.usdc),
        call: "approve",
        to: TOKEN_MESSENGER,
        units: amount,
      },
    ]);
    const burn = txs[1]!;
    expect(burn.to).toBe(TOKEN_MESSENGER);
    expect(burn.value ?? "0").toBe("0");
    const { functionName, args } = decodeFunctionData({
      abi: messengerAbi,
      data: burn.data as `0x${string}`,
    });
    expect(functionName).toBe("depositForBurnWithHook");
    const [burned, domain, mintRecipient, token, caller, maxFee, finality, hook] = args;
    // The card's amount of Arbitrum's USDC, bound for HyperEVM (domain 19).
    expect(burned).toBe(amount);
    expect(domain).toBe(19);
    expect(getAddress(token)).toBe(getAddress(NETWORKS.arbitrum.usdc));
    // Minted to Circle's forwarder, which alone may deliver it: anyone else for either, and
    // the money is lost for good.
    expect(mintRecipient).toBe(pad(FORWARDER).toLowerCase());
    expect(caller).toBe(pad(FORWARDER).toLowerCase());
    // No more kept than the card showed.
    expect(maxFee).toBe(BigInt(card.details.feeUnits!));
    expect(maxFee).toBe(200_000n);
    expect(finality).toBe(1000);
    // Credited to the owner's own Hyperliquid account, and no other.
    expect(hook).toBe(forwardHook(OWNER.evm));
    expect(hook).toContain(OWNER.evm.slice(2).toLowerCase());
    // And the card said plainly what Circle keeps of it, and what arrives.
    const arrives = usdLabel(Number(card.amountUsd) - 0.2);
    expect(card.card?.figures.slice(1, 3)).toEqual([
      { label: "You get", value: arrives, role: "gets" },
      { label: "Circle keeps", value: "$0.20" },
    ]);
    expect(JSON.stringify(card.lines)).toContain(arrives);
  },
  priceMoved: {
    "once Circle's fee rose past what its card showed": {
      input: { amountUsd: 20 },
      after: () => {
        world.forwardFee = 250_000;
      },
    },
  },
  takesMore: {
    "once the wallet holds less than its card's amount": {
      input: { amountUsd: 20 },
      after: () => {
        world.arbitrumUsdc = parseUnits("19.99", 6);
      },
    },
  },
  paysElsewhere: {
    never:
      "the messenger, the forwarder and the owner's own account are fixed in the calls, which paysAsShown reads",
  },
});

describe("a deposit by CCTP, as the move tells it", () => {
  const input = { amountUsd: 20 };
  const signer = { evmAddress: OWNER.evm, sendEvmTransaction: async () => "0xabc" } as never;

  it("notes what lands after the fee its card showed", async () => {
    world_();
    const preview = await hyperliquidDeposit.describe(input, {});
    expect(preview.details).toEqual({ arrivesOn: "Hyperliquid", feeUnits: "200000" });
    const ran = await hyperliquidDeposit.execute({
      action: { details: preview.details } as never,
      input,
      wallets: signer,
      recordSent: async () => {},
      posting: (_chain, post) => post(),
    });
    expect(ran).toEqual({
      txs: [{ chain: "arbitrum", hash: "0xabc" }],
      fills: [],
      run: { lands: "$19.80 on Hyperliquid" },
    });
  });

  it("makes no card for less than it carries, or when the fee would leave nothing", async () => {
    world_();
    expect(z.object(hyperliquidDeposit.input).safeParse({ amountUsd: 0.99 }).success).toBe(false);
    world.forwardFee = 20_000_000;
    await expect(hyperliquidDeposit.describe(input, {})).rejects.toThrow(
      "The fee for moving USDC into Hyperliquid is $20 now, as much as this would send, so nothing would arrive.",
    );
  });
});
