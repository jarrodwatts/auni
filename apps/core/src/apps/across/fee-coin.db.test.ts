import { NETWORKS } from "@auni/shared";
import { eq } from "drizzle-orm";
import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../../db/client.ts";
import { actions, fills, jobs, specialists } from "../../db/schema.ts";
import { proposeAction } from "../../money/actions.ts";
import type { PayInRequest } from "../../money/pay-in.ts";
import { insertSpecialist, insertThread, wipe } from "../../test/db.ts";
import { acrossBridge } from "./across.ts";

// The one money tool that both says what it would send (so its card may buy the chain's coin
// for its fees, money/fee-coin.ts) and can be a buy: bridge_usdc from Auni cash to a token on
// another chain. A specialist set to act on its own runs a buy that fits its pot with no tap,
// so this holds, through the real recipe and the real gate, that such a bridge never does: its
// card, purchase and all, waits for the owner.

const OWNER: Address = "0x2222222222222222222222222222222222222222";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ARBITRUM = NETWORKS.arbitrum.viem.id;
const MONAD = NETWORKS.monad.viem.id;
const MON = 10n ** 18n;
/** What the bridge's send on Arbitrum is short of ETH: a few cents. */
const LACKS = 12n * 10n ** 12n;
const DEPOSITORY: Address = "0x4444444444444444444444444444444444444444";
const depository = parseAbi(["function depositNative(address depositor, bytes32 id) payable"]);
const REQUEST: Hex = `0x${"ab".repeat(32)}`;

vi.mock("../../money/wallets.ts", async (original) => ({
  ...(await original<object>()),
  walletAddresses: async () => ({ evm: OWNER, solana: null }),
  evmAddress: async () => OWNER,
  solanaAddress: async () => null,
  // The wallet pays its own way everywhere, and holds no ETH on Arbitrum.
  paysOwnGas: async () => true,
}));
vi.mock("../../money/gas.ts", () => ({
  ownGas: vi.fn(async (chainId: number) =>
    chainId === ARBITRUM
      ? { short: "Too little ETH for gas.", fee: 1n, lacks: LACKS }
      : { short: null, fee: 1n },
  ),
  ownGasFees: vi.fn(),
}));
vi.mock("../../money/chains.ts", async (original) => ({
  ...(await original<object>()),
  evmClient: (chainId: number) => ({
    // 1,000 MON on Monad to buy the ETH with, and no USDC there.
    getBalance: async () => (chainId === MONAD ? 1_000n * MON : 0n),
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "wrappedNativeToken" ? WETH : functionName === "balanceOf" ? 0n : 18,
  }),
}));
vi.mock(import("../../money/token-feeds.ts"), async (original) => ({
  ...(await original()),
  feedListing: (async (chain: string) => ({
    usdPrice: chain === "monad" ? 0.0165 : 2_000,
  })) as never,
}));
vi.mock("../../money/wallet-effect.ts", async (original) => ({
  ...(await original<object>()),
  simulateEffect: async () => ({ out: [], in: [], grants: [], blind: false, sentTo: [], logs: [] }),
}));
vi.mock(import("../../money/funding.ts"), async (original) => ({
  ...(await original()),
  unpaid: async () => null,
}));
vi.mock(import("../../money/pay-in.ts"), async (original) => {
  const real = await original();
  return {
    ...real,
    payInQuote: async (request: PayInRequest) =>
      real.checkedQuote(
        request,
        {
          name: "Relay",
          depository: DEPOSITORY,
          deposit: (_data, value) => ({ depositor: request.user, token: "native", amount: value }),
        },
        {
          steps: [
            {
              id: "deposit",
              kind: "transaction",
              requestId: REQUEST,
              calls: [
                {
                  chainId: MONAD,
                  to: DEPOSITORY,
                  value: request.amount,
                  data: encodeFunctionData({
                    abi: depository,
                    functionName: "depositNative",
                    args: [request.user, REQUEST],
                  }),
                },
              ],
            },
          ],
          pays: { recipient: request.recipient, chain: "arbitrum", token: "native" },
          out: 100n * LACKS,
          least: 99n * LACKS,
        },
      ),
  };
});

/** Across's quote for $0.99 of Arbitrum USDC landing as WETH on Ethereum, as its API answers. */
const wethQuote = {
  swapTx: { chainId: ARBITRUM, to: "0xspoke", data: "0x" },
  expectedOutputAmount: "250000000000000",
  outputToken: { decimals: 18, symbol: "WETH" },
  steps: { originSwap: {}, bridge: {} },
};
const buy = { from_chain: "arbitrum", to_chain: "1", amount: "0.99", output_token: WETH } as const;

beforeEach(async () => {
  await wipe(specialists, actions, fills, jobs);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      Response.json(url.includes("swap/chains") ? [{ chainId: 1, name: "Ethereum" }] : wethQuote),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("bridge_usdc to a token that is not cash, from a specialist that acts on its own", () => {
  it("is a buy whose card buys the coin for its fees, and waits for the owner however large the pot", async () => {
    const specialist = await insertSpecialist({ potUsd: "100", actMode: "within_limits" });
    const own = await insertThread({ specialistId: specialist.id });
    const outcome = await proposeAction(
      { threadId: own.id, specialistId: specialist.id },
      acrossBridge,
      buy,
    );
    // The path the gate would let run unasked, were it weighed as any buy is: a buy, within
    // the pot, whose card also sends MON to Relay for the ETH its fee is paid in.
    expect(acrossBridge.direction?.(buy)).toBe("buy");
    expect(outcome.action.summary).toBe("Move $0.99 of USDC from Arbitrum to Ethereum as WETH");
    expect(outcome.action.details).toMatchObject({
      feeCoinOn: "arbitrum",
      feeCoinFrom: "monad",
      feeCoinToken: "native",
      feeCoinUsd: "0.25",
      feeCoinBy: "Relay",
    });
    // It asks, and nothing is queued to run it.
    expect(outcome.status).toBe("awaiting_permission");
    const [row] = await db.select().from(actions).where(eq(actions.id, outcome.action.id));
    expect(row).toMatchObject({ status: "awaiting_permission", phase: null, txs: [] });
    expect(await db.select().from(jobs)).toEqual([]);
  });
});
