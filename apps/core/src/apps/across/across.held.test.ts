import { NETWORKS } from "@auni/shared";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  maxUint256,
  pad,
  parseAbi,
  parseAbiParameters,
  type Hex,
  type Log,
} from "viem";
import { expect, vi } from "vitest";

import { publicClient } from "../../money/chains.ts";
import { parseUnits } from "../../money/usd.ts";
import { simulateEffect } from "../../money/wallet-effect.ts";
import { erc20Calls, holdsToCard } from "../../test/held-to-card.ts";
import { OWNER } from "../../test/wallets.ts";

// USDC moving from the owner's wallet on Base to their own wallet on Arbitrum. Across builds
// every byte: its API answers over fetch here, asking for an unlimited approval as it does, and
// what its deposit would really do is what the batch's simulation logs from Across's SpokePool,
// which `deposit` changes. Across takes 0.5% on the way.
const SPOKE_POOL = getAddress("0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64");
const STRANGER = "0x5555555555555555555555555555555555555555";
const DEPOSITED = parseAbi([
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
]);

interface Deposit {
  readonly lands: bigint;
  readonly takes: bigint;
  readonly chainId: bigint;
  readonly depositor: string;
  readonly recipient: string;
}
const world = vi.hoisted(() => ({ deposit: null as Partial<Deposit> | null, asked: 0n }));

vi.mock(import("../../money/wallet-effect.ts"), async (original) => ({
  ...(await original()),
  simulateEffect: vi.fn(),
}));
vi.mock(import("../../money/wallets.ts"), async (original) => ({
  ...(await original()),
  evmAddress: async () => (await import("../../test/wallets.ts")).OWNER.evm,
  paysOwnGas: async () => false,
}));

const word = (account: string) => pad(account.toLowerCase() as Hex);

/** The deposit as the SpokePool would log it for `asked` units, changed by `world.deposit`. */
function depositLog(asked: bigint): Log {
  const deposit: Deposit = {
    lands: (asked * 995n) / 1000n,
    takes: asked,
    chainId: BigInt(NETWORKS.arbitrum.viem.id),
    depositor: OWNER.evm,
    recipient: OWNER.evm,
    ...world.deposit,
  };
  const topics = encodeEventTopics({
    abi: DEPOSITED,
    eventName: "FundsDeposited",
    args: {
      destinationChainId: deposit.chainId,
      depositId: 7n,
      depositor: word(deposit.depositor),
    },
  });
  const data = encodeAbiParameters(
    parseAbiParameters(
      "bytes32, bytes32, uint256, uint256, uint32, uint32, uint32, bytes32, bytes32, bytes",
    ),
    [
      word(NETWORKS.base.usdc),
      word(NETWORKS.arbitrum.usdc),
      deposit.takes,
      deposit.lands,
      0,
      0,
      0,
      word(deposit.recipient),
      word("0x0"),
      "0x",
    ],
  );
  return { address: SPOKE_POOL, topics, data } as unknown as Log;
}

const toArbitrum = { from_chain: "base", to_chain: "arbitrum", amount: "50" };
const changing = (deposit: Partial<Deposit>) => ({
  input: toArbitrum,
  after: () => {
    world.deposit = deposit;
  },
});

holdsToCard("bridge_usdc", {
  world() {
    world.deposit = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const query = new URL(url).searchParams;
        if (!String(url).includes("swap/approval")) throw new Error(`Not stood in for: ${url}`);
        world.asked = BigInt(query.get("amount")!);
        return Response.json({
          approvalTxns: [
            {
              chainId: NETWORKS.base.viem.id,
              to: NETWORKS.base.usdc,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: "approve",
                args: [SPOKE_POOL, maxUint256],
              }),
            },
          ],
          swapTx: { chainId: NETWORKS.base.viem.id, to: SPOKE_POOL, data: "0xad5425c6" },
          expectedOutputAmount: String((world.asked * 995n) / 1000n),
          outputToken: { decimals: 6, symbol: "USDC" },
        });
      }),
    );
    // What Across's deposit carries to Arbitrum, as that chain says.
    vi.spyOn(publicClient("arbitrum"), "readContract").mockResolvedValue(6 as never);
    vi.mocked(simulateEffect).mockImplementation(async () => ({
      out: [{ token: getAddress(NETWORKS.base.usdc), amount: world.deposit?.takes ?? world.asked }],
      in: [],
      grants: [],
      blind: false,
      logs: [depositLog(world.asked)],
    }));
  },
  asShown: { "$50 of USDC from Base to the wallet on Arbitrum": toArbitrum },
  paysAsShown(signed, card) {
    // One batch on Base: exactly the card's USDC approved to Across's SpokePool, then the deposit.
    const units = parseUnits(card.amountUsd, 6);
    expect(signed.evm).toHaveLength(1);
    expect(signed.evm[0]!.chainId).toBe(NETWORKS.base.viem.id);
    expect(signed.evm[0]!.txs.at(-1)?.to).toBe(SPOKE_POOL);
    expect(erc20Calls(signed)).toEqual([
      {
        chainId: NETWORKS.base.viem.id,
        token: getAddress(NETWORKS.base.usdc),
        call: "approve",
        to: SPOKE_POOL,
        units,
      },
    ]);
  },
  priceMoved: {
    "once Across's fee would take 5% of it on the way": changing({ lands: 47_500_000n }),
  },
  takesMore: {
    "once the deposit's bytes would take more USDC than its card": changing({ takes: 60_000_000n }),
  },
  paysElsewhere: {
    "once the deposit would pay someone else on Arbitrum": changing({ recipient: STRANGER }),
    "once it would refund someone else if it never fills": changing({ depositor: STRANGER }),
    "once it would land on another chain": changing({ chainId: BigInt(NETWORKS.monad.viem.id) }),
  },
});
