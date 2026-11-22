import { readFileSync } from "node:fs";

import { NETWORKS } from "@auni/shared";
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from "@solana/kit";
import {
  bytesToHex,
  ContractFunctionRevertedError,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  hexToBytes,
  maxUint256,
  pad,
  parseAbi,
  parseAbiParameters,
  toEventSelector,
  zeroAddress,
  type Hex,
  type Log,
} from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionRow } from "../../db/schema.ts";
import { effectLines } from "../../money/effect.ts";
import { feeCoinCash, feeCoinsSaid, feeCoinUsd } from "../../money/fee-coin-said.ts";
import { EVM_NATIVE } from "../../money/fill-key.ts";
import { permissionDecision } from "../../money/permission.ts";
import { moneyOf } from "../../money/recipe.ts";
import { Refused } from "../../money/refused.ts";
import type { SolTopUp } from "../../money/sol-top-up.ts";
import { pinnedSol, RELAYED_SOL } from "../../test/sol.ts";
import { walletEffect, type SimulatedEffect } from "../../money/wallet-effect.ts";
import { acrossBridge, acrossQuote } from "./across.ts";
import { withdrawUsdc } from "../../money/recipes/withdraw.ts";

const { ownGas, sponsor } = vi.hoisted(() => ({
  ownGas: vi.fn(async (): Promise<{ short: string | null; fee: bigint } | null> => null),
  // Whether Solana's fees are the wallet's own to pay (local keys) or its sponsor's, and the
  // EVM chains whose fees it pays itself.
  sponsor: { paysSolana: false, paysOwn: new Set([1]) },
}));
vi.mock("../../money/wallets.ts", () => ({
  walletAddresses: async () => ({
    evm: "0x2222222222222222222222222222222222222222",
    solana: "JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n",
  }),
  evmAddress: async () => "0x2222222222222222222222222222222222222222",
  solanaAddress: async () => "JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n",
  // Ethereum is where the wallet pays its own gas, and Solana or another chain when a test says.
  paysOwnGas: async (chain: number | "solana") =>
    chain === "solana" ? sponsor.paysSolana : sponsor.paysOwn.has(chain),
}));
vi.mock("../../money/gas.ts", () => ({ ownGas, ownGasFees: vi.fn() }));
// Across's bytes as a simulation reads them: unless a test says otherwise, they send no more
// than was asked and leave nothing behind.
const { simulateEffect, simulateSolana } = vi.hoisted(() => ({
  simulateEffect: vi.fn(async (..._args: unknown[]): Promise<SimulatedEffect | null> => ({
    out: [],
    in: [],
    grants: [],
    blind: false,
    sentTo: [],
    logs: [],
  })),
  simulateSolana: vi.fn(async () => ({ effect: { out: [], in: [], grants: [] } })),
}));
vi.mock("../../money/wallet-effect.ts", async (original) => ({
  ...(await original()),
  simulateEffect,
}));
vi.mock("../../money/solana-effect.ts", async (original) => ({
  ...(await original()),
  simulateSolana,
}));
// What a token's own contract says of its decimals, on whichever chain it's read: USDC's 6
// unless named here.
const { DECIMALS } = vi.hoisted(() => ({
  DECIMALS: {
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": 18,
    "0x07696dcab55e62cfef953666b29fe1970518cb00": 8,
  } as Record<string, number>,
}));
vi.mock("../../money/chains.ts", async (original) => ({
  ...(await original()),
  // The wallet's USDC on Solana, which buys the SOL a deposit from there needs.
  solanaTokenBalance: async () => 1_000_000_000n,
  // …and Across's SpokePool there, of the coin it unwraps: WETH.
  evmClient: () => ({
    readContract: async ({ address: token, functionName }: Record<string, string>) =>
      functionName === "wrappedNativeToken"
        ? "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"
        : (DECIMALS[token?.toLowerCase() ?? ""] ?? 6),
  }),
}));
// SOL at $100.
vi.mock(import("../../money/token-feeds.ts"), async (original) => ({
  ...(await original()),
  solUsd: async () => 100,
}));

// Buying SOL sends a swap as setup, or Relay's deposit on Monad; how each is checked is
// in sol-top-up.test.ts.
const { solForFees } = vi.hoisted(() => ({ solForFees: vi.fn() }));
vi.mock("../../money/sol-top-up.ts", async (original) => {
  const real = await original<typeof import("../../money/sol-top-up.ts")>();
  solForFees.mockImplementation(real.solForFees);
  return {
    ...real,
    solForFees,
    topUpSol: async (
      wallets: {
        sendSolanaTransaction: (tx: string, options: object) => Promise<string>;
        sendEvmTransaction: (chainId: number, txs: object[]) => Promise<string>;
      },
      plan: SolTopUp,
    ) =>
      plan.via === "swap"
        ? [
            {
              chain: "solana",
              hash: await wallets.sendSolanaTransaction("swap", { setup: true }),
              setup: true,
            },
          ]
        : [{ chain: "monad", hash: await wallets.sendEvmTransaction(143, []), setup: true }],
  };
});

// Whose USDC account is open on Solana: everyone's, unless a test closes one. Opening one sends
// Auni's transaction as setup, with the card it runs on; how it's built, and the SOL a wallet
// paying its own way buys for it, is checked in usdc-account.test.ts.
const { closedUsdc, opened, solToOpen } = vi.hoisted(() => ({
  closedUsdc: new Set<string>(),
  opened: [] as unknown[],
  solToOpen: vi.fn(async (): Promise<SolTopUp | null> => null),
}));
vi.mock("../../money/usdc-account.ts", async (original) => ({
  ...(await original()),
  solToOpen,
  openUsdcAccount: async (
    wallets: { sendSolanaTransaction: (tx: string, options: object) => Promise<string> },
    owner: string,
    approved: unknown,
  ) => {
    if (!closedUsdc.has(owner)) return [];
    opened.push(approved);
    const hash = await wallets.sendSolanaTransaction("open-usdc", { setup: true });
    closedUsdc.delete(owner);
    return [{ chain: "solana", hash, setup: true }];
  },
}));

// Across's quote retries wait between asks; here they pass at once.
vi.mock("node:timers/promises", () => ({ setTimeout: async () => {} }));

const context = {};

const WALLET = "0x2222222222222222222222222222222222222222";
const SOMEONE = "0x9999999999999999999999999999999999999999";
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
// Across's SpokePools, as its own deployments list them, and Circle's CCTP TokenMessengerV2.
const SPOKE_POOL = {
  arbitrum: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
  base: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  ethereum: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
  monad: "0xd2ecb3afe598b746F8123CaE365a598DA831A449",
} as const;
const CCTP = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";

const VENUE_EVENTS = parseAbi([
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
]);

const word = (account: string) => pad(account.toLowerCase() as Hex);

/** A deposit as a SpokePool logs it: by default, $50 of USDC from Base landing $49.50 in the wallet on Monad. */
function fundsDeposited(
  at: string,
  deposit: Partial<{
    outputToken: string;
    outputAmount: bigint;
    destinationChainId: bigint;
    depositor: string;
    recipient: string;
    message: Hex;
  }> = {},
): Log {
  const {
    outputToken = NETWORKS.monad.usdc,
    outputAmount = 49_500_000n,
    destinationChainId = 143n,
    depositor = WALLET,
    recipient = WALLET,
    message = "0x",
  } = deposit;
  const topics = encodeEventTopics({
    abi: VENUE_EVENTS,
    eventName: "FundsDeposited",
    args: { destinationChainId, depositId: 7n, depositor: word(depositor) },
  });
  const data = encodeAbiParameters(
    parseAbiParameters(
      "bytes32, bytes32, uint256, uint256, uint32, uint32, uint32, bytes32, bytes32, bytes",
    ),
    [
      word(NETWORKS.base.usdc),
      word(outputToken),
      50_000_000n,
      outputAmount,
      0,
      0,
      0,
      word(recipient),
      word("0x0"),
      message,
    ],
  );
  return { address: at, topics, data } as unknown as Log;
}

/** A burn as Circle's TokenMessengerV2 logs it: by default, $50 of USDC minted to the wallet on Monad. */
function depositForBurn(
  burn: Partial<{
    mintRecipient: Hex;
    destinationDomain: number;
    maxFee: bigint;
    hookData: Hex;
  }> = {},
): Log {
  const {
    mintRecipient = word(WALLET),
    destinationDomain = 15,
    maxFee = 5_000n,
    hookData = "0x",
  } = burn;
  const topics = encodeEventTopics({
    abi: VENUE_EVENTS,
    eventName: "DepositForBurn",
    args: { burnToken: NETWORKS.base.usdc, depositor: WALLET, minFinalityThreshold: 1000 },
  });
  const data = encodeAbiParameters(
    parseAbiParameters("uint256, bytes32, uint32, bytes32, bytes32, uint256, bytes"),
    [50_000_000n, mintRecipient, destinationDomain, word("0x0"), word("0x0"), maxFee, hookData],
  );
  return { address: CCTP, topics, data } as unknown as Log;
}

/** A simulation that sends no more than was asked, leaves nothing behind, and logs `logs`. */
const simulated = (logs: Log[]) => ({
  out: [],
  in: [],
  grants: [],
  blind: false,
  sentTo: [],
  logs,
});

/** Across's quote as its API answers it, swapping as it leaves or on arrival when it says so. */
function acrossAnswer(quote: {
  chainId: number;
  expected: string;
  min?: string;
  decimals?: number;
  symbol?: string;
  originSwap?: true;
  swapsOnArrival?: true;
  approvalTxns?: { chainId: number; to: string; data: string }[];
}) {
  const { chainId, expected, min, decimals = 6, symbol = "USDC" } = quote;
  return {
    ...(quote.approvalTxns ? { approvalTxns: quote.approvalTxns } : {}),
    swapTx: { chainId, to: "0xspoke", data: "0x" },
    expectedOutputAmount: expected,
    ...(min ? { minOutputAmount: min } : {}),
    outputToken: { decimals, symbol },
    steps: {
      ...(quote.originSwap ? { originSwap: {} } : {}),
      bridge: {},
      ...(quote.swapsOnArrival ? { destinationSwap: {} } : {}),
    },
  };
}

// Across's MulticallHandlers, where a deposit lands first when Across swaps as it leaves or
// unwraps the coin on arrival, and its metadata log.
const HANDLER = {
  monad: "0xeC41F75c686e376Ab2a4F18bde263ab5822c4511",
  ethereum: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
} as const;
const EVENT_EMITTER = "0xBF75133b48b0a42AB9374027902E83C5E2949034";
const HANDLER_CALLS = parseAbi([
  "function drainLeftoverTokens(address token, address destination)",
  "function makeCallWithBalance(address target, bytes callData, uint256 value, (address token, uint256 offset)[] replacement)",
  "function emitData(bytes data)",
  "function withdraw(uint256 amount)",
]);
type HandlerCall = { target: string; callData: Hex; value: bigint };
const handlerCall = (target: string, callData: Hex): HandlerCall => ({
  target,
  callData,
  value: 0n,
});
/** The handler passing all it holds of `token` on to `to`. */
const drain = (handler: string, token: string, to = WALLET) =>
  handlerCall(
    handler,
    encodeFunctionData({
      abi: HANDLER_CALLS,
      functionName: "drainLeftoverTokens",
      args: [token as Hex, to as Hex],
    }),
  );
/** The handler unwrapping all the WETH it holds, as Across's quote for ETH asks. */
const unwrap = (handler: string) =>
  handlerCall(
    handler,
    encodeFunctionData({
      abi: HANDLER_CALLS,
      functionName: "makeCallWithBalance",
      args: [
        WETH,
        encodeFunctionData({ abi: HANDLER_CALLS, functionName: "withdraw", args: [0n] }),
        0n,
        [{ token: WETH, offset: 4n }],
      ],
    }),
  );
const metadata = handlerCall(
  EVENT_EMITTER,
  encodeFunctionData({ abi: HANDLER_CALLS, functionName: "emitData", args: ["0x01"] }),
);
/** A Transfer as a simulation of the fill logs it: the chain's own coin from EVM_NATIVE. */
const moved = (token: string, from: string, to: string, amount: bigint) =>
  ({
    address: token,
    topics: [toEventSelector("Transfer(address,address,uint256)"), word(from), word(to)],
    data: encodeAbiParameters(parseAbiParameters("uint256"), [amount]),
  }) as unknown as Log;
/** What a simulation of the fill on the chain it lands on reads its logs to do to the wallet. */
const arrived = (logs: Log[]) => ({ ...walletEffect(logs, WALLET), blind: false, logs });
/** A deposit's message to the handler: the calls it makes, and who gets what's left if one fails. */
const instructions = (calls: HandlerCall[], fallbackRecipient: string = zeroAddress) =>
  encodeAbiParameters(
    parseAbiParameters(
      "((address target, bytes callData, uint256 value)[] calls, address fallbackRecipient)",
    ),
    [{ calls: calls as never, fallbackRecipient: fallbackRecipient as Hex }],
  );

describe("bridge_usdc", () => {
  it("spends Auni cash when it moves USDC between Auni's chains", async () => {
    const bridge = { from_chain: "base", to_chain: "monad", amount: "50" } as const;
    expect(acrossBridge.fundedFrom?.({ input: bridge, details: {} })).toBe("base");
    expect(acrossBridge.direction?.(bridge)).toBeNull();
    const preview = await acrossBridge.describe(bridge, context);
    expect(preview.summary).toBe("Move $50 of USDC from Base to Monad");
    expect(preview.amountUsd).toBe("50.00");
    expect(preview.unpriced).toBeUndefined();
    // Cash changing places lets go of no holding.
    expect(preview.sells).toBeUndefined();
    // It says the least it lands, all but the most a bridge may lose, which execute holds it
    // to and a card's funding counts as arriving.
    expect(preview.details).toMatchObject({ getsAtLeast: "48.5" });
  });

  it("names a move of cash to the nearest cent, never a cent more than it moves", async () => {
    // The live card of 2026-11-16 read "Move $1.02 of USDC" for 1.010787 (finding 92).
    const bridge = { from_chain: "base", to_chain: "monad", amount: "1.010787" } as const;
    const preview = await acrossBridge.describe(bridge, context);
    expect(preview.summary).toBe("Move $1.01 of USDC from Base to Monad");
    expect(effectLines(preview.effect)[0]).toEqual({
      label: "You give",
      value: "$1.01 of USDC on Base",
    });
  });

  it("says Across's own transactions for a move of cash, so core checks the wallet can pay their gas", async () => {
    // The live plan of 2026-11-13: $2 from Polygon, where a wallet brought home from hosted
    // Auni holds no POL. Unquoted, it was never checked, and failed only after the tap. Now it
    // is quoted, and core checks what the quote would send (see fee-coin.ts).
    sponsor.paysOwn.add(137);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.includes("swap/chains")
            ? [{ chainId: 137, name: "Polygon" }]
            : acrossAnswer({ chainId: 137, expected: "1990000" }),
        ),
      ),
    );
    const bridge = { from_chain: "polygon", to_chain: "monad", amount: "2" } as const;
    const preview = await acrossBridge.describe(bridge, context);
    expect(preview.sends).toEqual({
      chainId: 137,
      calls: [{ chainId: 137, to: "0xspoke", data: "0x" }],
    });
    // It still reads as a plain move of cash.
    expect(preview.summary).toBe("Move $2 of USDC from Polygon to Monad");
    expect(preview.unpriced).toBeUndefined();
    expect(preview.details).toMatchObject({ getsAtLeast: "1.94" });
    sponsor.paysOwn.delete(137);
    vi.unstubAllGlobals();
  });

  describe("moving a token", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("names the holding it lets go of, so a card can say whose and a move can wait on it", async () => {
      const usdg = "0x5555555555555555555555555555555555555555";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          Response.json(
            url.includes("swap/tokens")
              ? [{ address: usdg, symbol: "USDG", decimals: 6, priceUsd: "1" }]
              : url.includes("swap/approval")
                ? acrossAnswer({ chainId: 4663, expected: "92100000" })
                : [{ chainId: 4663, name: "Robinhood Chain" }],
          ),
        ),
      );
      const bridge = { from_chain: "4663", from_token: "USDG", to_chain: "monad", amount: "92.3" };
      const preview = await acrossBridge.describe(bridge, context);
      // Robinhood Chain is one of Auni's networks, by its chain id too.
      expect(preview.sells).toEqual({ chain: "robinhood", instrument: usdg, quantity: "92.3" });
    });

    it("takes a chain's own coin by the name a holding gives it, native", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          Response.json(
            url.includes("swap/tokens")
              ? [{ address: zeroAddress, symbol: "ETH", decimals: 18, priceUsd: "3000" }]
              : url.includes("swap/approval")
                ? acrossAnswer({ chainId: 8453, expected: "29000000" })
                : [{ chainId: 8453, name: "Base" }],
          ),
        ),
      );
      const bridge = {
        from_chain: "base",
        from_token: "native",
        to_chain: "monad",
        amount: "0.01",
      };
      const preview = await acrossBridge.describe(bridge, context);
      expect(preview.sells).toEqual({ chain: "base", instrument: "native", quantity: "0.01" });
    });
  });

  describe("selling a token Across swaps but doesn't list", () => {
    afterEach(() => vi.unstubAllGlobals());

    // A token bought on Ethereum, on its way home.
    const wprl = "0x07696DcaB55E62cfef953666b29Fe1970518cB00";
    const home = { from_chain: "1", from_token: wprl, to_chain: "monad", amount: "1.0126" };
    const wallet = "0x2222222222222222222222222222222222222222";

    function stubAcross() {
      const quoted: URLSearchParams[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          if (url.includes("li.quest"))
            return Response.json({
              address: wprl,
              symbol: "WPRL",
              name: "Wrapped Pearl",
              decimals: 8,
              priceUSD: "1.95",
            });
          if (url.includes("swap/tokens")) return Response.json([]);
          if (url.includes("swap/chains")) return Response.json([{ chainId: 1, name: "Ethereum" }]);
          quoted.push(new URL(url).searchParams);
          // Across swaps it to USDC as it leaves, so a refund gives back USDC, not WPRL.
          return Response.json(
            acrossAnswer({ chainId: 1, expected: "1918123", min: "1871340", originSwap: true }),
          );
        }),
      );
      return quoted;
    }

    // A real card read "Move $1.95", "to move", over "Arrives about $1.91": a sale, said as
    // a move, headlined by the token's worth rather than what came back.
    it("brings it home as cash on one card that reads as the sale it is", async () => {
      const quoted = stubAcross();
      const preview = await acrossBridge.describe(home, context);
      expect(preview.summary).toBe("Sell 1.0126 WPRL on Ethereum for USDC on Monad");
      // Execute sends exactly this token, never a fresh lookup of its name.
      expect(preview.details?.fromToken).toBe(wprl);
      // What comes back is its one figure, and the way's cost against WPRL's $1.97 is said.
      expect(moneyOf({ ...preview, details: preview.details ?? {}, run: {} })).toEqual({
        flow: "back",
        usd: "1.92",
      });
      expect(effectLines(preview.effect)).toEqual([
        { label: "You give", value: "1.0126 WPRL on Ethereum ($1.97)" },
        { label: "You get", value: "at least $1.82 of USDC on Monad in ~1 min" },
        { label: "Costs", value: "$0.06 in the bridge's fee and the price it moves" },
      ]);
      // Cash it gathers, as convert_to_cash counts it: the least it lands, a slippage under this
      // quote's $1.87, which a fresh quote's own least must still reach for it to go.
      expect(preview.amountUsd).toBe("1.82");
      expect(preview.sells).toEqual({ chain: "ethereum", instrument: wprl, quantity: "1.0126" });
      expect(preview.details).toMatchObject({ getsAtLeast: "1.825698", returnsUsd: "1.92" });
      // Its card wears what it sells.
      expect(
        acrossBridge.about({ input: home, details: preview.details ?? {}, amountUsd: "0" }),
      ).toMatchObject({ kind: "token", chain: "ethereum", mint: wprl, symbol: "WPRL" });
      expect(quoted.at(-1)?.get("amount")).toBe("101260000");
      expect(quoted.at(-1)?.get("recipient")).toBe(wallet);
    });

    it("sends nothing once the price falls past what its card said it gets at least", async () => {
      stubAcross();
      const sent: unknown[] = [];
      await expect(
        acrossBridge.execute({
          action: { amountUsd: "1.93", details: { fromToken: wprl, getsAtLeast: "1.95" } } as never,
          input: home,
          wallets: {
            evmAddress: wallet,
            sendEvmTransaction: async (_chain: number, tx: unknown) => {
              sent.push(tx);
              return "0xdeposit";
            },
          } as never,
          recordSent: async () => {},
          posting: (_chain, post) => post(),
        }),
      ).rejects.toThrow("The price moved");
      expect(sent).toEqual([]);
    });

    it("leaves a token no one prices to a transaction Auni simulates", async () => {
      const unpriced = "0x9999999999999999999999999999999999999999";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          Response.json(
            url.includes("li.quest")
              ? { address: unpriced, symbol: "MEME", name: "Meme", decimals: 18 }
              : url.includes("swap/chains")
                ? [{ chainId: 1, name: "Ethereum" }]
                : [],
          ),
        ),
      );
      await expect(
        acrossBridge.describe({ ...home, from_token: unpriced }, context),
      ).rejects.toThrow(`Across can't move ${unpriced} from Ethereum.`);
    });

    it("records the sale its card named, at what lands", async () => {
      stubAcross();
      simulateEffect.mockResolvedValueOnce(
        simulated([fundsDeposited(SPOKE_POOL.ethereum, { outputAmount: 1_918_123n })]),
      );
      const result = await acrossBridge.execute({
        action: {
          amountUsd: "1.93",
          details: { fromToken: wprl, getsAtLeast: "1.825698" },
        } as never,
        input: home,
        wallets: { evmAddress: wallet, sendEvmTransaction: async () => "0xdeposit" } as never,
        recordSent: async () => {},
        posting: (_chain, post) => post(),
      });
      expect(result.fills).toEqual([
        {
          chain: "ethereum",
          instrument: wprl,
          side: "sell",
          quantity: "1.0126",
          usdValue: "1.918123",
        },
      ]);
      expect(result.run).toEqual({ lands: "$1.92 on Monad" });
    });
  });

  it("says the deposit a move off Ethereum would send, where the wallet pays its own gas", async () => {
    const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.includes("swap/chains")
            ? [{ chainId: 1, name: "Ethereum" }]
            : acrossAnswer({ chainId: 1, expected: "4998795" }),
        ),
      ),
    );
    const preview = await acrossBridge.describe(
      { from_chain: "ethereum", from_token: usdc, to_chain: "monad", amount: "5" },
      context,
    );
    expect(preview.sends).toEqual({
      chainId: 1,
      calls: [{ chainId: 1, to: "0xspoke", data: "0x" }],
    });
    vi.unstubAllGlobals();
  });

  it("records no sale of a token Across bridges as it is, which a refund gives back as itself", async () => {
    const usdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        Response.json(
          url.includes("swap/tokens")
            ? [{ address: usdc, symbol: "USDC", decimals: 6, priceUsd: "1" }]
            : url.includes("swap/chains")
              ? [{ chainId: 1, name: "Ethereum" }]
              : acrossAnswer({ chainId: 1, expected: "4998795" }),
        ),
      ),
    );
    // Its card moves it, and counts the least that lands, as a sale's does: USDC on Ethereum
    // isn't cash Auni spends, so it's a holding going home.
    const moved = await acrossBridge.describe(
      { from_chain: "1", from_token: usdc, to_chain: "monad", amount: "5" },
      context,
    );
    expect(moved.summary).toBe("Move 5 USDC from Ethereum to Monad");
    expect(moved.amountUsd).toBe("4.99");
    simulateEffect.mockResolvedValueOnce(
      simulated([fundsDeposited(SPOKE_POOL.ethereum, { outputAmount: 4_998_795n })]),
    );
    const result = await acrossBridge.execute({
      action: { amountUsd: "5.00", details: { fromToken: usdc } } as never,
      input: { from_chain: "1", from_token: usdc, to_chain: "monad", amount: "5" },
      wallets: {
        evmAddress: "0x2222222222222222222222222222222222222222",
        sendEvmTransaction: async () => "0xdeposit",
      } as never,
      recordSent: async () => {},
      posting: (_chain, post) => post(),
    });
    expect(result.fills).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("brings money home from another chain without spending Auni cash or buying", () => {
    const bridge = {
      from_chain: "4663",
      from_token: "USDG",
      to_chain: "monad",
      amount: "92.3",
      output_token: "0x1111111111111111111111111111111111111111",
    } as const;
    expect(acrossBridge.fundedFrom?.({ input: bridge, details: {} })).toBeNull();
    expect(acrossBridge.direction?.(bridge)).toBeNull();
  });

  it("buys what lands at a chain that isn't Auni's, so nothing there counts as Cash", () => {
    const bridge = { from_chain: "base", to_chain: "1", amount: "5", output_token: WETH } as const;
    expect(acrossBridge.readies?.(bridge)).toBeNull();
    expect(acrossBridge.direction?.(bridge)).toBe("buy");
  });

  describe("buying a token Across carries as it is", () => {
    afterEach(() => vi.unstubAllGlobals());

    const buy = {
      from_chain: "arbitrum",
      to_chain: "1",
      amount: "0.99",
      output_token: WETH,
    } as const;
    const wethQuote = acrossAnswer({
      chainId: 42161,
      expected: "250000000000000",
      decimals: 18,
      symbol: "WETH",
      originSwap: true,
    });
    const stub = (quote: object, status = "pending") =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          Response.json(
            url.includes("deposit/status")
              ? { status, depositRefundTxnRef: status === "refunded" ? "0xrefund" : null }
              : url.includes("swap/chains")
                ? [{ chainId: 1, name: "Ethereum" }]
                : quote,
          ),
        ),
      );

    it("says on the card what lands, after fees", async () => {
      stub(wethQuote);
      const preview = await acrossBridge.describe(buy, context);
      expect(preview.summary).toBe("Move $0.99 of USDC from Arbitrum to Ethereum as WETH");
      expect(effectLines(preview.effect)).toContainEqual({
        label: "You get",
        value: "about 0.00025 WETH on Ethereum in ~1 min",
      });
    });

    it("always asks, even in a specialist that acts on its own", async () => {
      stub(wethQuote);
      const preview = await acrossBridge.describe(buy, context);
      const leg = {
        direction: acrossBridge.direction?.(buy) ?? null,
        effect: preview.effect,
        amountUsd: preview.amountUsd,
        sells: null,
        unpriced: preview.unpriced !== undefined,
        feesUsd: null,
      };
      expect(leg.direction).toBe("buy");
      const specialist = { actsOnItsOwn: true, freeCashCents: 10_000n, holds: new Map() };
      expect(permissionDecision({ specialist, legs: [leg] })).toBe("ask");
    });

    it("puts up no card when fees would swallow what it sends", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          url.includes("swap/chains")
            ? Response.json([{ chainId: 1, name: "Ethereum" }])
            : Response.json(
                { message: "Bridge amount 990000 is too low to cover bridge fees 1162014" },
                { status: 400 },
              ),
        ),
      );
      const refusal = await acrossBridge.describe(buy, context).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(Refused);
      expect(refusal).toMatchObject({
        kind: "rule",
        message: expect.stringMatching(/^That's too little to move with Across now/u),
      });
    });

    const fromMonad = { from_chain: "monad", to_chain: "1", amount: "2", output_token: WETH };
    const execute = () =>
      acrossBridge.execute({
        action: {
          amountUsd: "2.00",
          details: { fromToken: NETWORKS.monad.usdc, getsAtLeast: "0.0005" },
        } as never,
        input: fromMonad,
        wallets: { evmAddress: WALLET, sendEvmTransaction: async () => "0xdeposit" } as never,
        recordSent: async () => {},
        posting: (_chain, post) => post(),
      });
    const monadQuote = acrossAnswer({
      chainId: 143,
      expected: "500000000000000",
      decimals: 18,
      symbol: "WETH",
    });
    const deposit = fundsDeposited(SPOKE_POOL.monad, {
      outputToken: WETH,
      outputAmount: 500_000_000_000_000n,
      destinationChainId: 1n,
    });

    // Across unwraps the coin on arrival: its handler gets WETH, unwraps it, and passes it on.
    describe("its chain's own coin", () => {
      const coin = { ...fromMonad, output_token: zeroAddress };
      const ethQuote = { ...monadQuote, outputToken: { decimals: 18, symbol: "ETH" } };
      const unwrapped = (calls: HandlerCall[]) =>
        fundsDeposited(SPOKE_POOL.monad, {
          outputToken: WETH,
          outputAmount: 500_000_000_000_000n,
          destinationChainId: 1n,
          recipient: HANDLER.ethereum,
          message: instructions(calls),
        });
      const executeCoin = () =>
        acrossBridge.execute({
          action: {
            amountUsd: "2.00",
            details: { fromToken: NETWORKS.monad.usdc, getsAtLeast: "0.0005" },
          } as never,
          input: coin,
          wallets: { evmAddress: WALLET, sendEvmTransaction: async () => "0xdeposit" } as never,
          recordSent: async () => {},
          posting: (_chain, post) => post(),
        });

      it("sends a deposit whose handler, simulated there, unwraps it and passes it on", async () => {
        stub(ethQuote);
        simulateEffect
          .mockResolvedValueOnce(
            simulated([
              unwrapped([
                unwrap(HANDLER.ethereum),
                drain(HANDLER.ethereum, zeroAddress),
                drain(HANDLER.ethereum, WETH),
                metadata,
              ]),
            ]),
          )
          .mockResolvedValueOnce(
            arrived([
              moved(EVM_NATIVE, WETH, HANDLER.ethereum, 500_000_000_000_000n),
              moved(EVM_NATIVE, HANDLER.ethereum, WALLET, 500_000_000_000_000n),
            ]),
          );
        const result = await executeCoin();
        // The coin arrives as itself, bought once Across fills it (see landed).
        expect(result.fills).toEqual([]);
        expect(result.run).toMatchObject({
          arrivesChain: "ethereum",
          arrivesToken: "native",
          arrivesQuantity: "0.0005",
        });
      });

      // A coin bought as it lands: the deposit carries USDC, the handler swaps it into WETH and
      // unwraps that. Arbitrum's WETH logs an unwrap as a transfer of it to the zero address,
      // which refused a live MON to ETH move on 2026-11-13 as paying someone else.
      const swappedThere = fundsDeposited(SPOKE_POOL.monad, {
        outputToken: NETWORKS.ethereum.usdc,
        outputAmount: 1_900_000n,
        destinationChainId: 1n,
        recipient: HANDLER.ethereum,
        message: instructions([unwrap(HANDLER.ethereum), drain(HANDLER.ethereum, zeroAddress)]),
      });
      const unwrappedBy = (token: string, to: string) =>
        arrived([
          moved(NETWORKS.ethereum.usdc, HANDLER.ethereum, SOMEONE, 1_900_000n),
          moved(WETH, SOMEONE, HANDLER.ethereum, 500_000_000_000_000n),
          moved(token, HANDLER.ethereum, to, 500_000_000_000_000n),
          moved(EVM_NATIVE, WETH, HANDLER.ethereum, 500_000_000_000_000n),
          moved(EVM_NATIVE, HANDLER.ethereum, WALLET, 500_000_000_000_000n),
        ]);

      it("sends one whose handler swaps into the wrapped coin and burns it to unwrap it", async () => {
        stub(ethQuote);
        simulateEffect
          .mockResolvedValueOnce(simulated([swappedThere]))
          .mockResolvedValueOnce(unwrappedBy(WETH, zeroAddress));
        expect((await executeCoin()).run).toMatchObject({ arrivesQuantity: "0.0005" });
      });

      it.each([
        ["the wrapped coin leaves the handler for someone else", WETH, SOMEONE],
        ["another token is burnt from the handler", NETWORKS.ethereum.usdt, zeroAddress],
      ])("refuses one where %s", async (_what, token, to) => {
        stub(ethQuote);
        simulateEffect
          .mockResolvedValueOnce(simulated([swappedThere]))
          .mockResolvedValueOnce(unwrappedBy(token, to));
        await expect(executeCoin()).rejects.toThrow("pays someone else on arrival");
      });

      it("refuses one whose handler leaves the coin behind", async () => {
        stub(ethQuote);
        simulateEffect
          .mockResolvedValueOnce(
            simulated([
              unwrapped([drain(HANDLER.ethereum, zeroAddress), unwrap(HANDLER.ethereum)]),
            ]),
          )
          .mockResolvedValueOnce(
            arrived([moved(EVM_NATIVE, WETH, HANDLER.ethereum, 500_000_000_000_000n)]),
          );
        await expect(executeCoin()).rejects.toThrow(
          "Across's deposit lands less than its card said",
        );
      });
    });

    // Across refunds a deposit no one fills only hours later, so what it buys is recorded
    // once it fills, and a refund buys nothing.
    describe("once it's sent", () => {
      const sentDeposit = async () => {
        stub(monadQuote);
        simulateEffect.mockResolvedValueOnce(simulated([deposit]));
        const result = await execute();
        const action = {
          amountUsd: "2.00",
          txs: result.txs,
          run: result.run,
        } as unknown as ActionRow;
        return { result, landing: { action, input: fromMonad, evmAddress: WALLET } };
      };
      const answer = (status: string) =>
        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            Response.json({
              status,
              fillTxnRef: status === "filled" ? "0xfill" : null,
              depositRefundTxnRef: status === "refunded" ? "0xrefund" : null,
            }),
          ),
        );

      it("records only what it sold, and stays on its way pinned to what arrives", async () => {
        const { result } = await sentDeposit();
        expect(result.fills).toEqual([]);
        expect(result.run).toEqual({
          lands: expect.stringMatching(/WETH on Ethereum$/),
          arrivesChain: "ethereum",
          arrivesToken: WETH,
          arrivesQuantity: "0.0005",
        });
      });

      it("buys what arrives once Across fills it", async () => {
        const { landing } = await sentDeposit();
        answer("filled");
        expect(await acrossBridge.landed?.(landing)).toEqual({
          delivered: "0xfill",
          bought: [
            {
              chain: "ethereum",
              instrument: WETH,
              side: "buy",
              quantity: "0.0005",
              usdValue: "2.00",
            },
          ],
        });
      });

      it("buys nothing when Across refunds it, naming the refund that delivered it back", async () => {
        const { landing } = await sentDeposit();
        answer("refunded");
        expect(await acrossBridge.landed?.(landing)).toEqual({
          note: "Across couldn't deliver it, so it went back to Monad.",
          delivered: "0xrefund",
        });
      });

      it("waits while Across hasn't settled it, then buys once it fills", async () => {
        const { landing } = await sentDeposit();
        for (const status of ["pending", "slowFillRequested", "expired"]) {
          answer(status);
          expect(await acrossBridge.landed?.(landing)).toBeNull();
        }
        answer("filled");
        expect(await acrossBridge.landed?.(landing)).toMatchObject({
          bought: [{ instrument: WETH, quantity: "0.0005" }],
        });
      });
    });
  });

  // Across swaps on arrival with calls its deposit carries to its MulticallHandler there, paying
  // whoever they name, so the deposit is signed only once those calls, simulated on the chain it
  // lands on, land what the card bought in the wallet. From a real quote (October 2026): $2 of
  // USDC on Arbitrum lands $1.83 of USDC on Ethereum, which Uniswap swaps into about 1.0506 WPRL,
  // at least 1.0190, with Across's relayer paying Ethereum's gas.
  describe("buying a token Across swaps into on arrival", () => {
    afterEach(() => vi.unstubAllGlobals());

    const WPRL = "0x07696DcaB55E62cfef953666b29Fe1970518cB00";
    const USDC = NETWORKS.ethereum.usdc;
    const ROUTER = "0x23617e59A5925b2A4Bf75d73ff6711cD0b29De85";
    const POOL = "0x000000000004444c5dc75cB358380D2e3dE08A90";
    const CARRIED = 1_833_913n;
    const buy = { from_chain: "arbitrum", to_chain: "ethereum", amount: "2", output_token: WPRL };
    const quote = acrossAnswer({
      chainId: 42161,
      expected: "105063448",
      min: "101901038",
      decimals: 8,
      symbol: "WPRL",
      swapsOnArrival: true,
    });
    beforeEach(() =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          Response.json(
            url.includes("deposit/status") ? { status: "filled", fillTxnRef: "0xfill" } : quote,
          ),
        ),
      ),
    );
    // Execute checks the swap by simulating it on the chain it lands on, with what the deposit
    // carries already there. Where no node can run that, the card would only fail after the tap.
    describe("as its card is made", () => {
      const carrying = {
        ...quote,
        steps: { ...quote.steps, bridge: { tokenOut: { address: USDC } } },
      };
      beforeEach(() =>
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => Response.json(carrying)),
        ),
      );

      it("tries the simulation execute will make, of what the deposit carries landed with the handler", async () => {
        await acrossBridge.describe(buy as never, {});
        expect(simulateEffect).toHaveBeenLastCalledWith(
          1,
          WALLET,
          [expect.objectContaining({ to: USDC })],
          expect.objectContaining({
            arriving: { token: USDC, holder: HANDLER.ethereum, amount: 1n },
          }),
        );
      });

      it("makes no card where the swap on arrival can't be checked", async () => {
        simulateEffect.mockResolvedValueOnce(null);
        await expect(acrossBridge.describe(buy as never, {})).rejects.toThrow(
          "Across would finish this with a swap on Ethereum, and Auni can't check that swap there",
        );
      });
    });

    /** Across's message: the router gets what landed, swaps it, and the handler passes on WPRL. */
    const swapThere = (to = WALLET, fallback = WALLET) =>
      instructions(
        [
          drain(HANDLER.ethereum, USDC, ROUTER),
          handlerCall(ROUTER, "0x24856bc3"),
          drain(HANDLER.ethereum, WPRL, to),
          drain(HANDLER.ethereum, USDC),
          metadata,
        ],
        fallback,
      );
    const deposit = (message: Hex) =>
      fundsDeposited(SPOKE_POOL.arbitrum, {
        outputToken: USDC,
        outputAmount: CARRIED,
        destinationChainId: 1n,
        recipient: HANDLER.ethereum,
        message,
      });
    /** The fill there as a simulation logs it: what landed swapped, and WPRL passed on. */
    const swapped = (...passedOn: [to: string, amount: bigint][]) => [
      moved(USDC, HANDLER.ethereum, ROUTER, CARRIED),
      moved(USDC, ROUTER, POOL, CARRIED),
      moved(WPRL, POOL, HANDLER.ethereum, 105_151_800n),
      ...passedOn.map(([to, amount]) => moved(WPRL, HANDLER.ethereum, to, amount)),
    ];
    /** What the fill there does, or what it does sent from `sender`. */
    type Arrival = SimulatedEffect | null | Error | ((sender: string) => SimulatedEffect);
    /** Executes the buy, its deposit's simulation logging one carrying `message`, or failing so. */
    const execute = (message: Hex | Error, arrival?: Arrival) => {
      if (message instanceof Error) simulateEffect.mockRejectedValueOnce(message);
      else simulateEffect.mockResolvedValueOnce(simulated([deposit(message)]));
      if (arrival instanceof Error) simulateEffect.mockRejectedValueOnce(arrival);
      else if (typeof arrival === "function")
        simulateEffect.mockImplementationOnce(async (_chainId, owner, _calls, options) =>
          arrival((options as { from?: string } | undefined)?.from ?? (owner as string)),
        );
      else if (arrival !== undefined) simulateEffect.mockResolvedValueOnce(arrival);
      const sent: unknown[] = [];
      const done = acrossBridge.execute({
        action: {
          amountUsd: "2.00",
          details: { fromToken: NETWORKS.arbitrum.usdc, getsAtLeast: "1.01901038" },
        } as never,
        input: buy,
        wallets: {
          evmAddress: WALLET,
          sendEvmTransaction: async (_chain: number, tx: unknown) => {
            sent.push(tx);
            return "0xdeposit";
          },
        } as never,
        recordSent: async () => {},
        posting: (_chain, post) => post(),
      });
      return { done, sent };
    };
    const refused = async (message: Hex, arrival: Arrival | undefined, reason: string) => {
      const { done, sent } = execute(message, arrival);
      await expect(done).rejects.toThrow(`Across's deposit ${reason}, so nothing was sent.`);
      expect(sent).toEqual([]);
    };

    it("puts up one card that buys it", async () => {
      const preview = await acrossBridge.describe(buy, context);
      expect(preview.summary).toBe("Move $2 of USDC from Arbitrum to Ethereum as WPRL");
      expect(effectLines(preview.effect)).toContainEqual({
        label: "You get",
        value: "about 1.0506 WPRL on Ethereum in ~1 min",
      });
      // A slippage under the quote's least, which a fresh quote's own least must reach.
      expect(preview.details).toMatchObject({ getsAtLeast: "0.98833816", mint: WPRL });
    });

    // Its swap there holds only the fresh quote's least, once Across fills it, so a fresh quote
    // still expecting more than the card's least isn't enough.
    it("sends nothing once a fresh quote's least falls under the card's", async () => {
      const sent: unknown[] = [];
      await expect(
        acrossBridge.execute({
          action: {
            amountUsd: "2.00",
            details: { fromToken: NETWORKS.arbitrum.usdc, getsAtLeast: "1.03" },
          } as never,
          input: buy,
          wallets: {
            evmAddress: WALLET,
            sendEvmTransaction: async (_chain: number, tx: unknown) => {
              sent.push(tx);
              return "0xdeposit";
            },
          } as never,
          recordSent: async () => {},
          posting: (_chain, post) => post(),
        }),
      ).rejects.toThrow("The price moved");
      expect(sent).toEqual([]);
    });

    // What the deposit reverts with in its simulation, as recorded (fixtures/problems/), kept as
    // the cause of core's own sentence, as simulateEffect throws it.
    const reverting = (fixture: string) => {
      const { answer } = JSON.parse(
        readFileSync(new URL(`fixtures/problems/${fixture}`, import.meta.url), "utf8"),
      ) as { answer: { error: { data: Hex } } };
      const cause = new ContractFunctionRevertedError({
        abi: [],
        data: answer.error.data,
        functionName: "deposit",
      });
      return new Error("Call 2 of 2 reverts in a simulation, so it would fail on chain.", {
        cause,
      });
    };
    const revertsWith = async (error: Error) => {
      const { done, sent } = execute(error);
      const thrown = await done.catch((caught: unknown) => caught);
      expect(sent).toEqual([]);
      return thrown;
    };

    it("says a deposit Across's pool would refuse in the owner's words, and sends nothing", async () => {
      expect(await revertsWith(reverting("stale-quote.json"))).toMatchObject({
        kind: "busy",
        message: expect.stringMatching(/^Across's quote went stale/u),
      });
      expect(await revertsWith(reverting("swap-moved.json"))).toMatchObject({ kind: "price" });
    });

    it("leaves a revert Across doesn't know as core's simulation said it", async () => {
      const strange = new Error("Call 1 of 2 reverts in a simulation, so it would fail on chain.", {
        cause: new ContractFunctionRevertedError({
          abi: [],
          data: "0xdeadbeef",
          functionName: "x",
        }),
      });
      expect(await revertsWith(strange)).toBe(strange);
    });

    it("sends the deposit once its fill, simulated there, lands at least the card's least in the wallet", async () => {
      const { done, sent } = execute(swapThere(), arrived(swapped([WALLET, 105_151_800n])));
      const result = await done;
      expect(sent).toHaveLength(1);
      expect(result.fills).toEqual([]);
      expect(result.run).toMatchObject({
        arrivesChain: "ethereum",
        arrivesToken: WPRL,
        arrivesQuantity: "1.05063448",
      });
      // The fill as Across's SpokePool there runs it: it hands the handler what the deposit
      // carries, then calls it with the deposit's own message.
      expect(simulateEffect).toHaveBeenLastCalledWith(
        1,
        WALLET,
        [
          {
            to: HANDLER.ethereum,
            data: encodeFunctionData({
              abi: parseAbi([
                "function handleV3AcrossMessage(address token, uint256 amount, address relayer, bytes message)",
              ]),
              functionName: "handleV3AcrossMessage",
              args: [USDC, CARRIED, zeroAddress, swapThere()],
            }),
          },
        ],
        {
          arriving: { token: USDC, holder: HANDLER.ethereum, amount: CARRIED },
          from: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
        },
      );
    });

    // At the fill a relayer sends it, so a call paying whoever sent it (tx.origin) pays the
    // relayer: a simulation sent from the wallet would read that as landing there.
    it("refuses a forged arrival whose helper pays whoever sends the fill", () => {
      const HELPER = "0x4444444444444444444444444444444444444444";
      return refused(
        instructions(
          [drain(HANDLER.ethereum, USDC, HELPER), handlerCall(HELPER, "0x12345678"), metadata],
          WALLET,
        ),
        (sender) =>
          arrived([
            moved(USDC, HANDLER.ethereum, HELPER, CARRIED),
            moved(USDC, HELPER, POOL, CARRIED),
            moved(WPRL, POOL, sender, 105_151_800n),
          ]),
        "lands less than its card said",
      );
    });

    it("refuses a forged arrival that passes what it buys to someone else", () =>
      refused(
        swapThere(SOMEONE),
        arrived(swapped([SOMEONE, 105_151_800n])),
        "lands less than its card said",
      ));

    it("refuses one passing some of what it buys to someone else, however much lands", () =>
      refused(
        swapThere(),
        arrived(swapped([SOMEONE, 3_000_000n], [WALLET, 102_151_800n])),
        "pays someone else on arrival",
      ));

    it("refuses one whose swap there lands less than its card said", () =>
      refused(
        swapThere(),
        arrived(swapped([WALLET, 100_000_000n])),
        "lands less than its card said",
      ));

    it("refuses one that takes from the wallet it lands in", () =>
      refused(
        swapThere(),
        arrived([...swapped([WALLET, 105_151_800n]), moved(USDC, WALLET, SOMEONE, 5n)]),
        "takes from who it lands with",
      ));

    it("refuses one whose failed calls there leave what landed to someone else", () =>
      refused(
        swapThere(WALLET, SOMEONE),
        undefined,
        "leaves what a failed call there doesn't spend to someone else",
      ));

    it("refuses one whose fill reverts there", () =>
      refused(swapThere(), new Error("Call 1 of 1 reverts"), "fails on arrival in a simulation"));

    it("sends nothing when its fill can't be simulated there", () =>
      refused(swapThere(), null, "can't be checked on the chain it lands on"));
  });

  describe("moving USDC", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("stays on its way until Across fills it", async () => {
      let status = "pending";
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          Response.json(
            url.includes("deposit/status")
              ? { status, fillTxnRef: status === "filled" ? "0xfill" : null }
              : acrossAnswer({ chainId: 8453, expected: "49500000" }),
          ),
        ),
      );
      const input = { from_chain: "base", to_chain: "monad", amount: "50" } as const;
      simulateEffect.mockResolvedValueOnce(simulated([fundsDeposited(SPOKE_POOL.base)]));
      const result = await acrossBridge.execute({
        action: { amountUsd: "50.00", details: { fromToken: NETWORKS.base.usdc } } as never,
        input,
        wallets: {
          evmAddress: "0x2222222222222222222222222222222222222222",
          sendEvmTransaction: async () => "0xdeposit",
        } as never,
        recordSent: async () => {},
        posting: (_chain, post) => post(),
      });
      expect(result.run).toEqual({ lands: "$49.50 on Monad" });
      const action = { txs: [{ chain: "base", hash: "0xdeposit" }] } as ActionRow;
      const landing = { action, input, evmAddress: "0x2222222222222222222222222222222222222222" };
      expect(await acrossBridge.landed?.(landing)).toBeNull();
      // Landed, it names the relayer's fill that delivered it, so its arrival is this move's.
      status = "filled";
      expect(await acrossBridge.landed?.(landing)).toEqual({ delivered: "0xfill" });
    });

    // Across built the deposit's bytes, which are signed as they came: what leaves the wallet
    // is simulated, and where it lands is only what Across's own SpokePool, or Circle's CCTP,
    // logs of it there. $50 of Auni cash on Base, whose card says about $50 lands on Monad, so
    // no less than $48.50 may.
    describe("holds what Across's deposit lands to its card", () => {
      // Across's API says $49.70 lands unless a test pins more; only the deposit's own log counts.
      const move = async (
        logs: Log[],
        approved: Record<string, string> = {},
        arrival?: Log[],
        asked: Record<string, string> = {},
      ) => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async (url: string) =>
            Response.json(
              url.includes("deposit/status")
                ? { status: "pending" }
                : acrossAnswer({ chainId: 8453, expected: "49700000" }),
            ),
          ),
        );
        simulateEffect.mockResolvedValueOnce(simulated(logs));
        if (arrival) simulateEffect.mockResolvedValueOnce(arrived(arrival));
        const sent: unknown[] = [];
        const done = acrossBridge.execute({
          action: {
            amountUsd: "50.00",
            details: { fromToken: NETWORKS.base.usdc, ...approved },
          } as never,
          input: { from_chain: "base", to_chain: "monad", amount: "50", ...asked },
          wallets: {
            evmAddress: WALLET,
            sendEvmTransaction: async (_chain: number, tx: unknown) => {
              sent.push(tx);
              return "0xdeposit";
            },
          } as never,
          recordSent: async () => {},
          posting: (_chain, post) => post(),
        });
        return { done, sent };
      };
      const refused = async (
        logs: Log[],
        reason: string,
        approved?: Record<string, string>,
        arrival?: Log[],
        asked?: Record<string, string>,
      ) => {
        const { done, sent } = await move(logs, approved, arrival, asked);
        await expect(done).rejects.toThrow(`Across's deposit ${reason}, so nothing was sent.`);
        expect(sent).toEqual([]);
      };

      it("sends a deposit that lands what its card said", async () => {
        const { done, sent } = await move([fundsDeposited(SPOKE_POOL.base)]);
        await done;
        expect(sent).toHaveLength(1);
      });

      it("sends one Circle's CCTP mints to the wallet", async () => {
        const { done, sent } = await move([depositForBurn()]);
        await done;
        expect(sent).toHaveLength(1);
      });

      it("refuses one paying someone else", () =>
        refused([fundsDeposited(SPOKE_POOL.base, { recipient: SOMEONE })], "pays someone else"));

      it("refuses one landing less than its card said", () =>
        refused(
          [fundsDeposited(SPOKE_POOL.base, { outputAmount: 48_000_000n })],
          "lands less than its card said",
        ));

      it("refuses one landing less than the least its card pinned", () =>
        refused([fundsDeposited(SPOKE_POOL.base)], "lands less than its card said", {
          getsAtLeast: "49.6",
        }));

      it("refuses one landing another token", () =>
        refused(
          [fundsDeposited(SPOKE_POOL.base, { outputToken: NETWORKS.base.usdc })],
          "lands another token",
        ));

      it("refuses one landing on another chain", () =>
        refused(
          [fundsDeposited(SPOKE_POOL.base, { destinationChainId: 1n })],
          "lands on another chain",
        ));

      it("refuses one any contract but Across's SpokePool there says it made", () =>
        refused([fundsDeposited(SPOKE_POOL.monad)], "isn't one Auni can find"));

      it("refuses one that makes no deposit at all", () => refused([], "isn't one Auni can find"));

      it("refuses one that would refund someone else", () =>
        refused(
          [fundsDeposited(SPOKE_POOL.base, { depositor: SOMEONE })],
          "would refund someone else",
        ));

      it("refuses one that runs calls on arrival", () =>
        refused(
          [fundsDeposited(SPOKE_POOL.base, { message: "0x1234" })],
          "asks for calls on arrival",
        ));

      it("refuses one split into a second deposit", () =>
        refused(
          [
            fundsDeposited(SPOKE_POOL.base),
            fundsDeposited(SPOKE_POOL.base, { recipient: SOMEONE }),
          ],
          "is split into several",
        ));

      // Across swapping as it leaves (a token going home) lands with its handler, whose calls a
      // simulation on the chain it lands on holds to the card.
      const handed = (calls: HandlerCall[], fallback?: string) =>
        fundsDeposited(SPOKE_POOL.base, {
          recipient: HANDLER.monad,
          message: instructions(calls, fallback),
        });
      const passed = (to: string, amount = 49_500_000n) =>
        moved(NETWORKS.monad.usdc, HANDLER.monad, to, amount);

      it("sends one Across's handler passes on to the wallet", async () => {
        const { done, sent } = await move(
          [handed([drain(HANDLER.monad, NETWORKS.monad.usdc), metadata])],
          {},
          [passed(WALLET)],
        );
        await done;
        expect(sent).toHaveLength(1);
      });

      it("refuses one the handler passes on to someone else", () =>
        refused(
          [handed([drain(HANDLER.monad, NETWORKS.monad.usdc, SOMEONE)])],
          "lands less than its card said",
          {},
          [passed(SOMEONE)],
        ));

      // With nothing to swap there, nothing may go anywhere but the wallet.
      it("refuses one the handler passes some of on to someone else", () =>
        refused(
          [handed([drain(HANDLER.monad, NETWORKS.monad.usdc)])],
          "pays someone else on arrival",
          {},
          [passed(SOMEONE, 500_000n), passed(WALLET, 49_000_000n)],
        ));

      it("refuses one whose failed calls leave it to someone else", () =>
        refused(
          [handed([drain(HANDLER.monad, NETWORKS.monad.usdc)], SOMEONE)],
          "leaves what a failed call there doesn't spend to someone else",
        ));

      it("refuses one the handler never passes on", () =>
        refused([handed([metadata])], "lands less than its card said", {}, []));

      it("refuses one landing with another chain's handler", () =>
        refused(
          [
            fundsDeposited(SPOKE_POOL.base, {
              recipient: HANDLER.ethereum,
              message: instructions([drain(HANDLER.ethereum, NETWORKS.monad.usdc)]),
            }),
          ],
          "pays someone else",
        ));

      it("refuses a CCTP burn minting to someone else", () =>
        refused([depositForBurn({ mintRecipient: word(SOMEONE) })], "pays someone else"));

      it("refuses a CCTP burn that asks for calls on arrival", () =>
        refused([depositForBurn({ hookData: "0x1234" })], "asks for calls on arrival"));

      // CCTP mints only USDC, so a card that said another token lands can't be one of its burns.
      it("refuses a CCTP burn when its card said another token lands", () =>
        refused([depositForBurn()], "lands another token", { getsAtLeast: "49" }, undefined, {
          output_token: NETWORKS.monad.usdc.replace(/.$/u, "0"),
        }));

      it("refuses a CCTP burn to another chain", () =>
        refused([depositForBurn({ destinationDomain: 0 })], "lands on another chain"));

      it("refuses a CCTP burn whose fee could take more than its card allows", () =>
        refused([depositForBurn({ maxFee: 2_000_000n })], "lands less than its card said"));
    });
  });

  // A withdrawal's proof vouched for where it goes (leavesTo), so Across's deposit must
  // pay exactly there, on the network its card named.
  describe("withdrawing to another network", () => {
    afterEach(() => vi.unstubAllGlobals());

    const EXCHANGE = "0x7777777777777777777777777777777777777777";
    // An exchange's Solana address, and its USDC account, as Across's own quote named it.
    const SOLANA_EXCHANGE = "JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n";
    const SOLANA_EXCHANGE_USDC = "8qahG34kuEuP8RySeDxq9HPt2fJewu4cMj5FZZdqQA6r";
    const solanaWord = (account: string) =>
      bytesToHex(new Uint8Array(getAddressEncoder().encode(address(account))));

    const withdraw = async (network: "base" | "solana", leavesTo: string, logs: Log[]) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(acrossAnswer({ chainId: 143, expected: "49900000" }))),
      );
      simulateEffect.mockResolvedValueOnce(simulated(logs));
      const sent: unknown[] = [];
      const done = withdrawUsdc.execute({
        action: {
          amountUsd: "50.00",
          details: { leavesTo, from: "monad", bridge: "across" },
        } as never,
        input: { amount_usd: "50", network, address: leavesTo, destination: "exchange" },
        wallets: {
          evmAddress: WALLET,
          solanaAddress: "So11111111111111111111111111111111111111112",
          sendEvmTransaction: async (_chain: number, tx: unknown) => {
            sent.push(tx);
            return "0xdeposit";
          },
        } as never,
        recordSent: async () => {},
        posting: (_chain, post) => post(),
      });
      return { done, sent };
    };
    const toExchange = (recipient: string) =>
      fundsDeposited(SPOKE_POOL.monad, {
        outputToken: NETWORKS.base.usdc,
        outputAmount: 49_900_000n,
        destinationChainId: 8453n,
        recipient,
      });

    it("sends a deposit paying the address its code vouched for", async () => {
      const { done, sent } = await withdraw("base", EXCHANGE, [toExchange(EXCHANGE)]);
      await done;
      expect(sent).toHaveLength(1);
    });

    it("refuses one paying anywhere else", async () => {
      const { done, sent } = await withdraw("base", EXCHANGE, [toExchange(SOMEONE)]);
      await expect(done).rejects.toThrow("Across's deposit pays someone else");
      expect(sent).toEqual([]);
    });

    it("sends a CCTP burn minting to the destination's own USDC account on Solana", async () => {
      const burn = depositForBurn({
        mintRecipient: solanaWord(SOLANA_EXCHANGE_USDC),
        destinationDomain: 5,
      });
      const { done, sent } = await withdraw("solana", SOLANA_EXCHANGE, [burn]);
      await done;
      expect(sent).toHaveLength(1);
    });

    it("refuses one minting to anyone else's", async () => {
      const burn = depositForBurn({
        mintRecipient: solanaWord(SOLANA_EXCHANGE),
        destinationDomain: 5,
      });
      const { done, sent } = await withdraw("solana", SOLANA_EXCHANGE, [burn]);
      await expect(done).rejects.toThrow("Across's deposit pays someone else");
      expect(sent).toEqual([]);
    });
  });

  // Circle's CCTP mints USDC on Solana only into an account already open, and Across quotes no
  // move landing with an owner who has none. Oct 30: both first moves to a fresh wallet failed so.
  describe("landing on Solana with no USDC account yet", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      closedUsdc.clear();
    });

    const SOLANA_WALLET = "JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n";
    // …and its USDC account, which Circle's CCTP mints to.
    const SOLANA_WALLET_USDC = "8qahG34kuEuP8RySeDxq9HPt2fJewu4cMj5FZZdqQA6r";
    const STAND_IN = "3tzNXZAnJaCVikmENJSnJFAzkAnediKTxH3ot9Hiwnkz";
    const REFUSAL =
      "Recipient's associated token account does not exist on Solana. The recipient must initialize their token account before receiving CCTP transfers.";
    const burn = depositForBurn({
      mintRecipient: bytesToHex(
        new Uint8Array(getAddressEncoder().encode(address(SOLANA_WALLET_USDC))),
      ),
      destinationDomain: 5,
    });

    /**
     * Across as it answers: no quote landing USDC with an owner whose account isn't open, nor,
     * its first `behind` times, with one just opened, which it reads a little behind. The recipient
     * of each quote it was asked for.
     */
    function stubAcross(behind = 0, refusal = REFUSAL) {
      const quoted: string[] = [];
      let refusals = behind;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          const query = new URL(url).searchParams;
          const recipient = query.get("recipient") ?? "";
          quoted.push(recipient);
          if (query.get("outputToken") === NETWORKS.solana.usdc && closedUsdc.has(recipient))
            return Response.json({ message: REFUSAL }, { status: 400 });
          if (refusals-- > 0) return Response.json({ message: refusal }, { status: 400 });
          return Response.json(acrossAnswer({ chainId: 143, expected: "20980000" }));
        }),
      );
      return quoted;
    }

    function solanaWallet(solanaAddress: string) {
      const sent: unknown[] = [];
      const wallets = {
        evmAddress: WALLET,
        solanaAddress,
        sendSolanaTransaction: async (tx: string, options: object) => {
          sent.push({ tx, ...options });
          return "signature-of-open";
        },
        sendEvmTransaction: async (_chain: number, tx: unknown) => {
          sent.push(tx);
          return "0xdeposit";
        },
      };
      return { sent, wallets: wallets as never };
    }

    // Simulated only when it gets as far as a deposit to send.
    const bridge = (wallets: never, deposits = true) => {
      if (deposits) simulateEffect.mockResolvedValueOnce(simulated([burn]));
      return acrossBridge.execute({
        action: { amountUsd: "20.99", details: { fromToken: NETWORKS.monad.usdc } } as never,
        input: { from_chain: "monad", to_chain: "solana", amount: "20.99" },
        wallets,
        recordSent: async () => {},
        posting: (_chain, post) => post(),
      });
    };

    it("opens the wallet's USDC account before it quotes, then sends the deposit", async () => {
      closedUsdc.add(SOLANA_WALLET);
      const quoted = stubAcross();
      const { sent, wallets } = solanaWallet(SOLANA_WALLET);
      const result = await bridge(wallets);
      expect(sent[0]).toEqual({ tx: "open-usdc", setup: true });
      expect(quoted).toEqual([SOLANA_WALLET]);
      expect(result.txs).toEqual([
        { chain: "solana", hash: "signature-of-open", setup: true },
        { chain: "monad", hash: "0xdeposit" },
      ]);
    });

    it("shows the SOL a wallet paying its own way buys to open it, and opens it on that card", async () => {
      closedUsdc.add(SOLANA_WALLET);
      stubAcross();
      solToOpen.mockResolvedValueOnce(RELAYED_SOL);
      const input = { from_chain: "monad", to_chain: "solana", amount: "20.99" } as const;
      const preview = await acrossBridge.describe(input, context);
      expect(solToOpen).toHaveBeenCalledWith(SOLANA_WALLET, SOLANA_WALLET);
      // As "Move $1.50 of USDC from Polygon to Solana" did, its Costs said "$1 Solana network
      // fee" for the dollar of SOL it buys, most of which stays, beside "$0.25 POL for fees" on
      // the same card, and the AI told the owner the fees came to more than the stock they'd
      // buy. It is said as the POL is, beside the move and with what stays, and is no cost.
      expect(effectLines(preview.effect).map(({ label }) => label)).not.toContain("Costs");
      expect(preview.details).toMatchObject(pinnedSol("1000000"));
      expect(feeCoinsSaid([{ details: preview.details! }])).toBe(
        "Also buys about $1 of SOL for network fees, most of which stays in your wallet. Bought through Relay.",
      );

      opened.length = 0;
      simulateEffect.mockResolvedValueOnce(simulated([burn]));
      const { wallets } = solanaWallet(SOLANA_WALLET);
      const action = { amountUsd: "20.99", details: preview.details };
      await acrossBridge.execute({
        action: action as never,
        input,
        wallets,
        recordSent: async () => {},
        posting: (_chain, post) => post(),
      });
      expect(opened).toEqual([action]);
    });

    it("asks Across again while it reads the account just opened as missing", async () => {
      closedUsdc.add(SOLANA_WALLET);
      const quoted = stubAcross(2);
      const { sent, wallets } = solanaWallet(SOLANA_WALLET);
      await bridge(wallets);
      expect(quoted).toEqual([SOLANA_WALLET, SOLANA_WALLET, SOLANA_WALLET]);
      expect(sent).toHaveLength(2);
    });

    it("says in plain words when Across still hasn't seen the account after a minute", async () => {
      closedUsdc.add(SOLANA_WALLET);
      stubAcross(Infinity);
      const { wallets } = solanaWallet(SOLANA_WALLET);
      await expect(bridge(wallets, false)).rejects.toThrow(
        "Solana is still getting this wallet ready to hold USDC. Nothing was sent, so try again in a minute.",
      );
    });

    it("asks no more once Across refuses it for any other reason", async () => {
      closedUsdc.add(SOLANA_WALLET);
      const quoted = stubAcross(1, "No bridge routes found");
      const { wallets } = solanaWallet(SOLANA_WALLET);
      await expect(bridge(wallets, false)).rejects.toThrow("No bridge routes found");
      expect(quoted).toEqual([SOLANA_WALLET]);
    });

    it("opens a withdrawal destination's USDC account before Across lands there", async () => {
      closedUsdc.add(SOLANA_WALLET);
      stubAcross();
      simulateEffect.mockResolvedValueOnce(simulated([burn]));
      const { sent, wallets } = solanaWallet("So11111111111111111111111111111111111111112");
      const result = await withdrawUsdc.execute({
        action: {
          amountUsd: "20.99",
          details: { leavesTo: SOLANA_WALLET, from: "monad", bridge: "across" },
        } as never,
        input: {
          amount_usd: "20.99",
          network: "solana",
          address: SOLANA_WALLET,
          destination: "wallet",
        },
        wallets,
        recordSent: async () => {},
        posting: (_chain, post) => post(),
      });
      expect(sent[0]).toEqual({ tx: "open-usdc", setup: true });
      expect(result.txs).toHaveLength(2);
    });

    it("quotes a card landing there as landing with Across's own account, whose fee is the same", async () => {
      closedUsdc.add(SOLANA_WALLET);
      const quoted = stubAcross();
      const transfer = {
        from: "monad",
        to: "solana",
        amount: "20.99",
        depositor: WALLET,
        recipient: SOLANA_WALLET,
      } as const;
      expect((await acrossQuote(transfer)).expectedOutputAmount).toBe("20980000");
      expect(quoted).toEqual([STAND_IN]);
    });
  });

  describe("from Solana", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      sponsor.paysSolana = false;
    });

    const SOLANA_WALLET = "JAVqaEWH9wJNxufknvhNuo6LGSxQzUm2B3B1mMjk6X8n";
    /** The account Circle keeps a deposit's message in, as the live one of 2026-11-16 was. */
    const MESSAGE_ACCOUNT = "4WggwDc8tGnBsSRTUBLVDjhF1Pytrn258xWL2ZbknfC6";
    const EVM_WALLET = "0x2222222222222222222222222222222222222222";
    const STRANGER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const input = { from_chain: "solana", to_chain: "monad", amount: "19" } as const;
    // The card's top-up for a wallet with no SOL: the deposit's 2,834,480 lamports and the
    // 650,240 the wallet keeps, at $100 a SOL and a tenth over, $0.38332, which execute spends.
    const card = { fromToken: NETWORKS.solana.usdc, ...pinnedSol("383320", "swap") };

    /**
     * Across's deposit from Solana: one of Circle's CCTP burns, its arguments in
     * deposit_for_burn's bytes. By default it mints to the wallet on Monad, a cent at most kept.
     */
    function burnTransaction(burn: {
      amount: bigint;
      domain?: number;
      mintRecipient?: Hex;
      maxFee?: bigint;
      program?: string;
      /** Who pays the rent of the message account it makes: the wallet, by default. */
      rentPayer?: string;
    }): string {
      const data = new Uint8Array(96);
      const view = new DataView(data.buffer);
      data.set(hexToBytes("0xd73c3d2e723780b0"), 0);
      view.setBigUint64(8, burn.amount, true);
      view.setUint32(16, burn.domain ?? 15, true);
      data.set(hexToBytes(burn.mintRecipient ?? word(EVM_WALLET)), 20);
      view.setBigUint64(84, burn.maxFee ?? 10_000n, true);
      view.setUint32(92, 1000, true);
      const lifetime = {
        blockhash: "11111111111111111111111111111111" as Blockhash,
        lastValidBlockHeight: 0n,
      };
      const program = address(burn.program ?? "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (draft) => setTransactionMessageFeePayer(address(SOLANA_WALLET), draft),
        (draft) => setTransactionMessageLifetimeUsingBlockhash(lifetime, draft),
        (draft) =>
          appendTransactionMessageInstruction(
            {
              programAddress: program,
              data,
              // deposit_for_burn's accounts: its 2nd pays the rent of its 12th, the message's.
              accounts: [
                SOLANA_WALLET,
                burn.rentPayer ?? SOLANA_WALLET,
                ...Array.from({ length: 9 }, () => "SysvarRent111111111111111111111111111111111"),
                MESSAGE_ACCOUNT,
              ].map((account, index) => ({
                address: address(account),
                role: index === 2 ? AccountRole.READONLY : AccountRole.WRITABLE,
              })),
            },
            draft,
          ),
      );
      return getBase64EncodedWireTransaction(compileTransaction(message));
    }

    /**
     * Solana answers with the wallet's SOL; Across quotes what it's asked to send, less a cent,
     * as a burn of all of it (see burnTransaction), changed by `burn`.
     */
    function stubChains(
      lamports: number,
      status = "pending",
      routes = true,
      burn: Omit<Parameters<typeof burnTransaction>[0], "amount"> = {},
    ) {
      const quoted: URLSearchParams[] = [];
      const statuses: URLSearchParams[] = [];
      const deposits: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init?: RequestInit) => {
          if (init?.body) return Response.json({ result: { value: lamports } });
          const query = new URL(url).searchParams;
          if (url.includes("deposit/status")) {
            statuses.push(query);
            return Response.json({ status });
          }
          quoted.push(query);
          if (!routes) return Response.json({ message: "No bridge routes found" }, { status: 400 });
          const amount = BigInt(query.get("amount") ?? "0");
          deposits.push(burnTransaction({ amount, ...burn }));
          return Response.json({
            approvalTxns: null,
            swapTx: {
              ecosystem: "svm",
              chainId: 34_268_394_551_451,
              to: "CCTP",
              data: deposits.at(-1),
            },
            expectedOutputAmount: String(amount - 10_000n),
            outputToken: { decimals: 6, symbol: "USDC" },
          });
        }),
      );
      return { quoted, statuses, deposits };
    }

    function solanaWallets() {
      const sent: { tx: string; setup?: true; paysOwnFee?: true }[] = [];
      const wallets = {
        evmAddress: EVM_WALLET,
        solanaAddress: SOLANA_WALLET,
        sendSolanaTransaction: async (
          tx: string,
          options?: { setup?: true; paysOwnFee?: true },
        ) => {
          sent.push({ tx, ...options });
          return `signature-of-${tx === "swap" ? tx : "deposit"}`;
        },
      };
      return { sent, wallets: wallets as never };
    }

    it("spends Solana cash, getting it ready on the chain it lands on", async () => {
      stubChains(0);
      expect(acrossBridge.fundedFrom?.({ input, details: {} })).toBe("solana");
      expect(acrossBridge.readies?.(input)).toBe("monad");
      expect(acrossBridge.direction?.(input)).toBeNull();
      const preview = await acrossBridge.describe(input, context);
      expect(preview.summary).toBe("Move $19 of USDC from Solana to Monad");
      // What buys the deposit's SOL, as execute works it out below, comes out of what lands; the
      // rent Circle holds of it comes back, which the card says in a few words (finding 91).
      expect(effectLines(preview.effect)).toEqual([
        { label: "You give", value: "$19 of USDC on Solana" },
        {
          label: "You get",
          value: "about $18.62 of USDC on Monad in ~1 min, $0.28 of SOL back from Circle in 5 days",
        },
      ]);
      // Pinned as every purchase of a fee's coin is, and as coming out of the $19 it sends: so
      // every drawing of its card says it, and no pot or plan counts it beside the $19.
      expect(preview.details).toMatchObject({
        ...pinnedSol("383320", "swap"),
        feeCoinWithin: "yes",
      });
      expect(feeCoinsSaid([{ details: preview.details! }])).toBe(
        "Also buys about $0.38 of SOL for network fees, most of which stays in your wallet. Bought through Jupiter.",
      );
      expect(feeCoinUsd(preview.details!)).toBeNull();
      expect(feeCoinCash(preview.details!)).toBeNull();
    });

    it("reads Across's id for Solana as Solana cash", () => {
      const bridge = { ...input, from_chain: "34268394551451" };
      expect(acrossBridge.fundedFrom?.({ input: bridge, details: {} })).toBe("solana");
    });

    it("moves only USDC out of Solana", async () => {
      await expect(
        acrossBridge.describe({ ...input, from_token: "BONK" }, context),
      ).rejects.toThrow("From Solana only USDC bridges");
    });

    it("buys the SOL the deposit needs with some of what it sends, then sends Across's deposit", async () => {
      const { quoted, statuses, deposits } = stubChains(0);
      const { sent, wallets } = solanaWallets();
      const result = await acrossBridge.execute({
        action: { amountUsd: "19.00", details: card } as never,
        input,
        wallets,
        recordSent: async () => {},
        posting: (_chain, post) => post(),
      });
      // The deposit's 2,834,480 lamports and the 650,240 the wallet keeps, at $100 a SOL and a
      // tenth over: $0.38332 of the $19. Across has signed the deposit, so the wallet pays for it.
      expect(sent).toEqual([
        { tx: "swap", setup: true },
        { tx: deposits.at(-1), paysOwnFee: true },
      ]);
      // Across signed its own part, the wallet pays its own way, and the rest is held to what
      // the deposit spends.
      expect(simulateSolana).toHaveBeenCalledWith(deposits.at(-1), SOLANA_WALLET, {
        othersSigned: true,
        paysOwnFee: true,
      });
      expect(quoted.at(-1)?.get("amount")).toBe("18616680");
      expect(quoted.at(-1)?.get("depositor")).toBe(SOLANA_WALLET);
      expect(quoted.at(-1)?.get("recipient")).toBe(EVM_WALLET);
      expect(result.txs).toEqual([
        { chain: "solana", hash: "signature-of-swap", setup: true },
        { chain: "solana", hash: "signature-of-deposit" },
      ]);
      expect(result.run).toEqual({ lands: "$18.61 on Monad" });

      // Across finds the deposit by its Solana signature.
      const action = { txs: result.txs } as ActionRow;
      const landing = { action, input, evmAddress: EVM_WALLET };
      expect(await acrossBridge.landed?.(landing)).toBeNull();
      expect(statuses.at(-1)?.get("originChainId")).toBe("34268394551451");
      expect(statuses.at(-1)?.get("depositTxnRef")).toBe("signature-of-deposit");
    });

    it("buys the deposit's SOL with USDC on Monad for a wallet with no sponsor, and sends it all", async () => {
      sponsor.paysSolana = true;
      stubChains(0);
      // Once for the card, once as it sends.
      const relay = { ...RELAYED_SOL, quote: {} };
      solForFees.mockResolvedValueOnce(relay).mockResolvedValueOnce(relay);
      const preview = await acrossBridge.describe(input, context);
      expect(effectLines(preview.effect)).toEqual([
        { label: "You give", value: "$19 of USDC on Solana" },
        {
          label: "You get",
          value: "about $19 of USDC on Monad in ~1 min, $0.28 of SOL back from Circle in 5 days",
        },
      ]);
      expect(feeCoinsSaid([{ details: preview.details! }])).toBe(
        "Also buys about $1 of SOL for network fees, most of which stays in your wallet. Bought through Relay.",
      );

      const { deposits, quoted } = stubChains(0);
      const { sent, wallets } = solanaWallets();
      const evmSends: number[] = [];
      expect(preview.details).toMatchObject({ feeCoinOn: "solana", feeCoinAmount: "1000000" });
      const result = await acrossBridge.execute({
        action: { amountUsd: "19.00", details: preview.details } as never,
        input,
        wallets: {
          ...(wallets as object),
          sendEvmTransaction: async (chainId: number) => {
            evmSends.push(chainId);
            return "0xrelay";
          },
        } as never,
        recordSent: async () => {},
        posting: (_chain, post) => post(),
      });
      expect(quoted.at(-1)?.get("amount")).toBe("19000000");
      expect(evmSends).toEqual([143]);
      // Bought just what the card showed, and no more.
      expect(solForFees).toHaveBeenLastCalledWith(3_484_720n, {
        approved: expect.objectContaining({ details: preview.details }),
      });
      expect(sent).toEqual([{ tx: deposits.at(-1), paysOwnFee: true }]);
      expect(result.txs).toEqual([
        { chain: "monad", hash: "0xrelay", setup: true },
        { chain: "solana", hash: "signature-of-deposit" },
      ]);
    });

    it("pays from its own SOL when the wallet pays its own way and holds enough, buying none", async () => {
      sponsor.paysSolana = true;
      stubChains(10_000_000);
      const preview = await acrossBridge.describe(input, context);
      expect(effectLines(preview.effect)).toEqual([
        { label: "You give", value: "$19 of USDC on Solana" },
        {
          label: "You get",
          value: "about $19 of USDC on Monad in ~1 min, $0.28 of SOL back from Circle in 5 days",
        },
      ]);
      expect(preview.details).not.toHaveProperty("feeCoinAmount");
      const { quoted, deposits } = stubChains(10_000_000);
      const { sent, wallets } = solanaWallets();
      solForFees.mockClear();
      await acrossBridge.execute({
        action: { amountUsd: "19.00", details: preview.details } as never,
        input,
        wallets,
        recordSent: async () => {},
        posting: (_chain, post) => post(),
      });
      expect(solForFees).not.toHaveBeenCalled();
      expect(sent).toEqual([{ tx: deposits.at(-1), paysOwnFee: true }]);
      expect(quoted.at(-1)?.get("amount")).toBe("19000000");
    });

    it("gets back the SOL Circle holds for its message once Circle allows, as its card said", async () => {
      // Live, 2026-11-16: a $1.01 bridge out of Solana left 2,824,480 lamports with Circle,
      // unshown and never reclaimed (finding 91).
      sponsor.paysSolana = true;
      const run = async (burn = {}) => {
        stubChains(10_000_000, "pending", true, burn);
        const preview = await acrossBridge.describe(input, context);
        stubChains(10_000_000, "pending", true, burn);
        return acrossBridge.execute({
          action: { amountUsd: "19.00", details: preview.details } as never,
          input,
          wallets: solanaWallets().wallets,
          recordSent: async () => {},
          posting: (_chain, post) => post(),
        });
      };
      const sent = Date.now();
      const { later } = await run();
      expect(later).toEqual([
        {
          tool: "across_reclaim",
          input: { account: MESSAGE_ACCOUNT },
          summary: "Got back the SOL Circle held for a move from Solana",
          at: expect.any(Date),
        },
      ]);
      // Five days on, and an hour more, so the chain's clock has passed it too.
      const due = later![0]!.at.getTime() - sent;
      expect(due).toBeGreaterThanOrEqual(121 * 60 * 60_000);
      expect(due).toBeLessThan(121 * 60 * 60_000 + 60_000);
      // Rent someone else pays is none of the wallet's to get back.
      expect((await run({ rentPayer: STRANGER })).later).toEqual([]);
    });

    it("buys no SOL its card didn't show, and sends nothing", async () => {
      stubChains(0);
      const { sent, wallets } = solanaWallets();
      await expect(
        acrossBridge.execute({
          action: { amountUsd: "19.00", details: { fromToken: NETWORKS.solana.usdc } } as never,
          input,
          wallets,
          recordSent: async () => {},
          posting: (_chain, post) => post(),
        }),
      ).rejects.toThrow("its card showed buying none");
      expect(sent).toEqual([]);
    });

    it("still buys what the deposit spends when the wallet holds SOL, which may be a holding", async () => {
      const { quoted, deposits } = stubChains(10_000_000);
      const { sent, wallets } = solanaWallets();
      await acrossBridge.execute({
        action: { amountUsd: "19.00", details: { ...card, feeCoinAmount: "311793" } } as never,
        input,
        wallets,
        recordSent: async () => {},
        posting: (_chain, post) => post(),
      });
      // Only the deposit's 2,834,480 lamports, a tenth over: $0.311793.
      expect(sent).toEqual([
        { tx: "swap", setup: true },
        { tx: deposits.at(-1), paysOwnFee: true },
      ]);
      expect(quoted.at(-1)?.get("amount")).toBe("18688207");
    });

    it("buys nothing when Across can't take the route", async () => {
      stubChains(0, "pending", false);
      const { sent, wallets } = solanaWallets();
      await expect(
        acrossBridge.execute({
          action: { amountUsd: "19.00", details: card } as never,
          input,
          wallets,
          recordSent: async () => {},
          posting: (_chain, post) => post(),
        }),
      ).rejects.toThrow("No bridge routes found");
      expect(sent).toEqual([]);
    });

    it("buys no SOL for a deposit that would land less than its card said", async () => {
      stubChains(0);
      const { sent, wallets } = solanaWallets();
      await expect(
        acrossBridge.execute({
          action: {
            amountUsd: "19.00",
            details: { ...card, getsAtLeast: "19" },
          } as never,
          input,
          wallets,
          recordSent: async () => {},
          posting: (_chain, post) => post(),
        }),
      ).rejects.toThrow("The price moved");
      expect(sent).toEqual([]);
    });

    // The deposit is one of Circle's CCTP burns, whose arguments sit in the bytes the wallet
    // signs: held to the card before any SOL is bought for it.
    it.each([
      ["minting to someone else", { mintRecipient: word(SOMEONE) }, "pays someone else"],
      ["to another chain", { domain: 6 }, "lands on another chain"],
      ["whose fee could take more than its card allows", { maxFee: 1_000_000n }, "lands less"],
      [
        "made by any program but Circle's",
        { program: "11111111111111111111111111111111" },
        "isn't one Auni can find",
      ],
    ])("buys no SOL for a burn %s, and sends nothing", async (_, burn, reason) => {
      stubChains(0, "pending", true, burn);
      const { sent, wallets } = solanaWallets();
      await expect(
        acrossBridge.execute({
          action: { amountUsd: "19.00", details: card } as never,
          input,
          wallets,
          recordSent: async () => {},
          posting: (_chain, post) => post(),
        }),
      ).rejects.toThrow(reason);
      expect(sent).toEqual([]);
    });

    it("puts up no card for a move its SOL would take half of", async () => {
      stubChains(0);
      await expect(acrossBridge.describe({ ...input, amount: "0.7" }, context)).rejects.toThrow(
        "its network fee would take half",
      );
    });
  });

  describe("approvals", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("approves only what the transfer spends when Across asks for unlimited", async () => {
      const spender = "0x2222222222222222222222222222222222222222";
      const unlimited = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, maxUint256],
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            acrossAnswer({
              chainId: 8453,
              expected: "49000000",
              approvalTxns: [{ chainId: 8453, to: "0xusdc", data: unlimited }],
            }),
          ),
        ),
      );
      const quote = await acrossQuote({
        from: "base",
        to: "monad",
        amount: "50",
        depositor: spender,
        recipient: spender,
      });
      const approval = quote.approvalTxns?.[0];
      expect(
        decodeFunctionData({ abi: erc20Abi, data: approval?.data as `0x${string}` }).args,
      ).toEqual([spender, 50_000_000n]);
    });

    // Across builds every byte, so they go only as one batch its simulation holds to the transfer.
    describe("at execute", () => {
      const wallet = "0x2222222222222222222222222222222222222222";
      const approve = encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [wallet, 50_000_000n],
      });
      const send = async (sent: unknown[]) =>
        acrossBridge.execute({
          action: { amountUsd: "50.00", details: { fromToken: NETWORKS.base.usdc } } as never,
          input: { from_chain: "base", to_chain: "monad", amount: "50" },
          wallets: {
            evmAddress: wallet,
            sendEvmTransaction: async (_chain: number, tx: unknown) => {
              sent.push(tx);
              return "0xdeposit";
            },
          } as never,
          recordSent: async () => {},
          posting: (_chain, post) => post(),
        });

      afterEach(() => simulateEffect.mockClear());

      it("sends the approval and the deposit as one batch, so no approval outlives a deposit that fails", async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            Response.json(
              acrossAnswer({
                chainId: 8453,
                expected: "49500000",
                approvalTxns: [{ chainId: 8453, to: NETWORKS.base.usdc, data: approve }],
              }),
            ),
          ),
        );
        simulateEffect.mockResolvedValueOnce(simulated([fundsDeposited(SPOKE_POOL.base)]));
        const sent: unknown[] = [];
        await send(sent);
        const batch = [
          { to: NETWORKS.base.usdc, data: approve, setup: true },
          { to: "0xspoke", data: "0x" },
        ];
        expect(sent).toEqual([batch]);
        expect(simulateEffect).toHaveBeenCalledWith(8453, wallet, batch);
      });

      it("sends nothing whose simulation takes more than the transfer", async () => {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => Response.json(acrossAnswer({ chainId: 8453, expected: "49500000" }))),
        );
        simulateEffect.mockResolvedValueOnce({
          ...simulated([fundsDeposited(SPOKE_POOL.base)]),
          out: [{ token: NETWORKS.base.usdc, amount: 60_000_000n }],
        } as never);
        const sent: unknown[] = [];
        await expect(send(sent)).rejects.toThrow("would send more than was shown");
        expect(sent).toEqual([]);
      });
    });
  });
});
