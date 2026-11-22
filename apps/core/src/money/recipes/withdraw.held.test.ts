import { NETWORKS } from "@auni/shared";
import { getAddress } from "viem";
import { expect, vi } from "vitest";

import type { BridgeTransfer } from "../../apps/contract.ts";
import { erc20Calls, holdsToCard, solanaTransfers } from "../../test/held-to-card.ts";
import { usdcAccountOf } from "../usdc-account.ts";
import { parseUnits } from "../usd.ts";

// The owner holds $100 of USDC on Base, Monad and Solana, and sends to an address of their own
// elsewhere; between networks, through a bridge that lands it, minus a fee, where it was sent.
const EXCHANGE = "0x2222222222222222222222222222222222222222";
const SOLANA_FRIEND = "JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n";

const bridged = vi.hoisted(() => ({ transfers: [] as BridgeTransfer[] }));

vi.mock("../wallets.ts", async (original) => ({
  ...(await original()),
  walletAddresses: async () => {
    const { OWNER } = await import("../../test/wallets.ts");
    return { evm: OWNER.evm, solana: OWNER.solana };
  },
}));
vi.mock("../withdrawals.ts", async (original) => ({
  ...(await original()),
  refuseTokenDestination: async () => {},
  walletUsdc: async () =>
    new Map([
      ["base", 100_000_000n],
      ["monad", 100_000_000n],
      ["solana", 100_000_000n],
    ]),
}));
// The wallet holds the SOL a Solana transfer's fee takes, and the recipient's USDC account is open.
vi.mock("../sol-top-up.ts", async (original) => ({
  ...(await original()),
  solFor: async () => null,
}));
vi.mock("../usdc-account.ts", async (original) => ({
  ...(await original()),
  solToOpen: async () => null,
}));
vi.mock("../chains.ts", async (original) => ({
  ...(await original()),
  solanaKitRpc: () => ({
    getLatestBlockhash: () => ({
      send: async () => ({
        value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0n },
      }),
    }),
  }),
}));
vi.mock("../../apps/registry.ts", async (original) => {
  const real = await original<typeof import("../../apps/registry.ts")>();
  const bridge = {
    recipe: real.firstBridge().bridge.recipe,
    quote: async ({ amount }: BridgeTransfer) => ({
      expectedOutputAmount: String(Number(amount) * 1e6 - 100_000),
    }),
    // A bridge's own drill holds its bytes to what it was asked; this one says what it was asked.
    send: async (transfer: BridgeTransfer, wallets: import("../recipe.ts").Signer) => {
      bridged.transfers.push(transfer);
      const { NETWORKS: networks } = await import("@auni/shared");
      const chain = networks[transfer.from as "monad"].viem.id;
      return {
        txs: [
          {
            chain: transfer.from,
            hash: await wallets.sendEvmTransaction(chain, { to: transfer.recipient }),
          },
        ],
      };
    },
  };
  const about = { ...real.firstBridge().about, id: "test-bridge" };
  return {
    ...real,
    firstBridge: () => ({ about, bridge }),
    filling: ((kind: string) =>
      kind === "bridge"
        ? [{ about, part: bridge }]
        : real.filling(kind as never)) as typeof real.filling,
  };
});

const usdc = (usd: string) => parseUnits(usd, 6);

holdsToCard("withdraw_usdc", {
  world: () => {
    bridged.transfers = [];
  },
  asShown: {
    "to an exchange on Base": {
      amount_usd: "25",
      network: "base",
      address: EXCHANGE,
      destination: "exchange",
    },
    "to a wallet on Solana": {
      amount_usd: "12.5",
      network: "solana",
      address: SOLANA_FRIEND,
      destination: "wallet",
    },
    "to an exchange on Arbitrum, bridged from the wallet's cash on another network": {
      amount_usd: "40",
      network: "arbitrum",
      address: EXCHANGE,
      destination: "exchange",
    },
  },
  async paysAsShown(signed, card) {
    const to = card.details.leavesTo!;
    const network = card.input.network as "base" | "arbitrum" | "solana";
    expect(to).toBe(network === "solana" ? SOLANA_FRIEND : getAddress(EXCHANGE));
    if (card.details.from !== network) {
      // Between networks, the bridge is asked to pay the card's destination the card's amount.
      expect(bridged.transfers).toEqual([
        expect.objectContaining({ to: network, recipient: to, amount: card.amountUsd }),
      ]);
      return;
    }
    if (network === "solana") {
      expect(solanaTransfers(signed)).toEqual([
        {
          mint: NETWORKS.solana.usdc,
          destination: await usdcAccountOf(to),
          amount: usdc(card.amountUsd),
        },
      ]);
      return;
    }
    expect(erc20Calls(signed)).toEqual([
      {
        chainId: NETWORKS[network].viem.id,
        token: getAddress(NETWORKS[network].usdc!),
        call: "transfer",
        to,
        units: usdc(card.amountUsd),
      },
    ]);
  },
  priceMoved: {
    never:
      "a withdrawal moves USDC dollar for dollar; one between networks is held to what lands by its bridge's own drill",
  },
  takesMore: { never: "it sends its card's amount, which no quote sizes" },
  paysElsewhere: {
    never:
      "Auni builds the transfer itself, to the destination its card pinned, which paysAsShown reads",
  },
});
