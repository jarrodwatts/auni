import { setTimeout as sleep } from "node:timers/promises";

import { isCash, NETWORKS, type CashKey, type NetworkKey } from "@auni/shared";
import {
  address,
  getAddressEncoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from "@solana/kit";
import {
  bytesToHex,
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddress,
  isAddressEqual,
  pad,
  parseAbi,
  parseAbiParameters,
  toEventSelector,
  toFunctionSelector,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";
import { z } from "zod";

import { BRIDGE_LOSS_BPS } from "../contract.ts";
import type { ActionRow } from "../../db/schema.ts";
import {
  APPROVED_PROCEEDS,
  assertApprovedProceeds,
  assertBytesDo,
  pinnedToken,
  type Approved,
} from "../../money/approved.ts";
import { sameDestination } from "../../money/effect.ts";
import {
  chainIdOf,
  chainKey,
  chainName,
  evmChainById,
  evmClient,
  SOLANA_USDC,
  solanaRpc,
} from "../../money/chains.ts";
import { formatAmount, usdLabel } from "../../money/format.ts";
import {
  EVM_NATIVE,
  evmTokenKey,
  solanaMintKey,
  WRAPPED_SOL,
  type FillChain,
  type FillKey,
} from "../../money/fill-key.ts";
import {
  tradedToken,
  type ActionPreview,
  type EvmTx,
  type ExecuteResult,
  type Fill,
  type FundingChain,
  type Recipe,
  type SentTx,
  type Signer,
} from "../../money/recipe.ts";
import { dollars } from "../../money/summaries.ts";
import { centsToUsd, formatUnits, normalizeUsd, parseUnits } from "../../money/usd.ts";
import { simulateSolana, SOLANA_KEEP_LAMPORTS } from "../../money/solana-effect.ts";
import { simulateEffect } from "../../money/wallet-effect.ts";
import { evmAddress, noAddressOn, paysOwnGas, solanaAddress } from "../../money/wallets.ts";
import {
  outOfWhatItSends,
  solForFees,
  topUpSol,
  withTopUp,
  type SolTopUp,
} from "../../money/sol-top-up.ts";
import { usd } from "../../money/swaps/shared.ts";
import { feedListing } from "../../money/token-feeds.ts";
import { apiRefusal, depositRefusal } from "./problems.ts";
import {
  CCTP_SOLANA,
  RECLAIM_SUMMARY,
  RECLAIM_TOOL,
  RENT_HELD_MS,
  rentBack,
  rentHeldBy,
} from "./rent.ts";
import { openUsdcAccount, solToOpen, usdcAccountOf } from "../../money/usdc-account.ts";

const ACROSS_API = "https://app.across.to/api";
// Across's own id for Solana in its EVM-shaped chain space.
const ACROSS_SOLANA_CHAIN_ID = 34_268_394_551_451;
// When what a bridge sends lands on the other chain, as its card says: Across usually fills in a minute.
const LANDS_IN = "in ~1 min";

const input = {
  from_chain: z
    .string()
    .min(1)
    .describe(
      'Where the money is: one of Auni\'s networks by name (monad, base, ethereum, ink…), solana (USDC only), or any other EVM chain Across supports by its chain id (e.g. "4663" for Robinhood Chain).',
    ),
  to_chain: z
    .string()
    .min(1)
    .describe(
      "Where it arrives, always in the owner's own wallet: one of Auni's networks by name (monad, base, ethereum…), solana, or any other chain Across supports by its chain id (e.g. \"4663\" for Robinhood Chain).",
    ),
  from_token: z
    .string()
    .min(1)
    .optional()
    .describe(
      "What leaves: USDC when omitted, or the token's symbol (USDG, ETH) or address; \"native\" for the chain's own coin.",
    ),
  amount: z
    .string()
    .regex(/^\d+(\.\d+)?$/u)
    .describe("How much of from_token to send, as a decimal string."),
  output_token: z
    .string()
    .optional()
    .describe(
      "Token to receive on the destination chain, when not USDC: any token Across swaps into " +
        "there, as it leaves or on arrival. An ERC-20 address (the zero address for the chain's " +
        "own coin), or a mint on Solana.",
    ),
};

interface AcrossTx {
  readonly chainId: number;
  readonly to: string;
  readonly data: string;
  readonly value?: string;
  readonly ecosystem?: "evm" | "svm";
}

interface AcrossQuote {
  readonly approvalTxns?: AcrossTx[] | null;
  readonly swapTx: AcrossTx;
  readonly expectedOutputAmount: string;
  /** The least that lands once its slippage is spent. */
  readonly minOutputAmount?: string;
  readonly steps?: {
    /** A swap on the chain it leaves, when what leaves isn't what Across bridges. */
    readonly originSwap?: unknown;
    /** What crosses: the token the deposit carries to the chain it lands on. */
    readonly bridge?: { readonly tokenOut?: { readonly address?: string } };
  };
  readonly outputToken: { readonly decimals: number; readonly symbol: string };
}

/** A token as Across lists it on one chain. */
interface AcrossToken {
  readonly address: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly priceUsd?: string;
}

async function across<T>(path: string, query: Record<string, string>): Promise<T> {
  const response = await fetch(`${ACROSS_API}/${path}?${new URLSearchParams(query)}`, {
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok || !body) throw apiRefusal(response.status, body);
  return body;
}

/** Where a bridge leaves or lands: one of Auni's chains, or any other EVM chain by its id. */
type BridgeChain = NetworkKey | number;

function bridgeChain(chain: string): BridgeChain {
  if (chain === "solana") return "solana";
  const id = chainIdOf(chain);
  return id === ACROSS_SOLANA_CHAIN_ID ? "solana" : (evmChainById(id)?.key ?? id);
}

function acrossChainId(chain: BridgeChain): number {
  if (typeof chain === "number") return chain;
  return chain === "solana" ? ACROSS_SOLANA_CHAIN_ID : NETWORKS[chain].viem.id;
}

const acrossChains = () => across<{ chainId: number; name: string }[]>("swap/chains", {});

async function chainLabel(chain: BridgeChain): Promise<string> {
  if (typeof chain !== "number") return chainName(chain);
  const chains = await acrossChains().catch(() => []);
  return chains.find((listed) => listed.chainId === chain)?.name ?? `chain ${chain}`;
}

/**
 * A destination's name; a chain Across doesn't reach, or Auni can't read, is
 * refused here, before anything is shown.
 */
async function destinationLabel(to: BridgeChain): Promise<string> {
  if (typeof to !== "number") return chainName(to);
  evmClient(to);
  const listed = (await acrossChains()).find((chain) => chain.chainId === to);
  if (!listed) throw new Error(`Across doesn't reach chain ${to}.`);
  return listed.name;
}

const isUsdc = (token: string | undefined) => !token || token.toUpperCase() === "USDC";

/** Native USDC on one of Auni's networks that has it; null anywhere else. */
const knownUsdc = (chain: BridgeChain) => (typeof chain === "number" ? null : NETWORKS[chain].usdc);

/** The chain's native USDC (see knownUsdc) when `token` names it, by symbol or address; else null. */
const usdcOn = (chain: BridgeChain, token: string | undefined) => {
  const usdc = knownUsdc(chain);
  return usdc !== null && (isUsdc(token) || token?.toLowerCase() === usdc.toLowerCase())
    ? usdc
    : null;
};

/**
 * USDC on Auni's networks that have it is known; anything else is looked up
 * in Across's list for that chain. Across also swaps from tokens it doesn't
 * list, on the chain they leave, so one named by address that a token feed lists
 * and prices can leave too: a token bought on another chain (WPRL on Ethereum)
 * goes home this way. Priced, so its card and its sale say
 * what it was worth.
 */
async function acrossToken(chain: BridgeChain, token: string | undefined): Promise<AcrossToken> {
  const usdc = usdcOn(chain, token);
  if (usdc !== null) return { address: usdc, symbol: "USDC", decimals: 6, priceUsd: "1" };
  // A chain's own coin, as a holding names it ("native"), Across lists by its symbol.
  const named =
    token === "native" && typeof chain !== "number" ? NETWORKS[chain].coin.asset.symbol : token;
  const wanted = (named ?? "USDC").toLowerCase();
  const listed = await across<AcrossToken[]>("swap/tokens", {
    chainId: String(acrossChainId(chain)),
  });
  const found =
    listed.find((listing) => listing.address.toLowerCase() === wanted) ??
    listed.find((listing) => listing.symbol.toLowerCase() === wanted);
  if (found) return found;
  const priced =
    chain !== "solana" && token && isAddress(token)
      ? await feedListing(chainKey(acrossChainId(chain)), token).catch(() => null)
      : null;
  if (!priced?.usdPrice)
    throw new Error(`Across can't move ${token ?? "USDC"} from ${await chainLabel(chain)}.`);
  const { address, symbol, decimals, usdPrice } = priced;
  return { address, symbol, decimals, priceUsd: String(usdPrice) };
}

/** Across builds every calldata byte; Auni only signs what the swap API returns. */
async function quote(query: Record<string, string>): Promise<AcrossQuote> {
  const body = await across<AcrossQuote>("swap/approval", query);
  if (!body.swapTx) throw new Error("Across could not quote this bridge.");
  return body;
}

interface AcrossTransfer {
  readonly from: BridgeChain;
  readonly to: BridgeChain;
  /** What leaves, in its own units; USDC on an Auni chain or Solana when no token is given. */
  readonly amount: string;
  readonly inputToken?: AcrossToken;
  /** Whose wallet it leaves. */
  readonly depositor: string;
  /** Who receives it on arrival: the owner's own wallet, or a withdrawal's destination. */
  readonly recipient: string;
  /** What lands: USDC when absent, Across's listing of it on a chain Auni doesn't name. */
  readonly outputToken?: string;
}

/**
 * Where a deposit can go, as Auni knows it rather than as Across's API says: Across's SpokePool
 * on each EVM chain, from Across's own deployments (@across-protocol/contracts 5.0.27,
 * dist/broadcast/deployed-addresses.json, mainnets only). A chain not listed sends nothing.
 */
const SPOKE_POOLS: Readonly<Partial<Record<number, Address>>> = {
  1: "0x5c7BCd6E7De5423a257D81B442095A1a6ced35C5",
  10: "0x6f26Bf09B1C792e3228e5467807a900A503c0281",
  56: "0x4e8E101924eDE233C13e2D8622DC8aED2872d505",
  130: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  137: "0x9295ee1d8C5b022Be115A2AD3c30C72E34e7F096",
  143: "0xd2ecb3afe598b746F8123CaE365a598DA831A449",
  232: "0xb234cA484866c811d0e6D3318866F583781ED045",
  288: "0xBbc6009fEfFc27ce705322832Cb2068F8C1e0A58",
  324: "0xE0B015E54d54fc84a6cB9B666099c46adE9335FF",
  480: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  999: "0x35E63eA3eb0fb7A3bc543C71FB66412e1F6B0E04",
  1135: "0x9552a0a6624A23B848060AE5901659CDDa1f83f8",
  1868: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96",
  4217: "0x2d4710F04Da90184255782d3715224A6C776955D",
  4326: "0x3Db06DA8F0a24A525f314eeC954fC5c6a973d40E",
  4663: "0xD29C85F15DF544bA632C9E25829fd29d767d7978",
  5042: "0x9b4A302A548c7e313c2b74C461db7b84d3074A84",
  8453: "0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64",
  9745: "0x50039fAEfebef707cFD94D6d462fE6D10B39207a",
  34443: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96",
  42161: "0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A",
  43114: "0xFE9D541c92E4e90437C7152A00244886dE37a658",
  57073: "0xeF684C38F94F48775959ECf2012D7E864ffb9dd4",
  59144: "0x7E63A5f1a8F0B4d0934B2f2327DAED3F6bb2ee75",
  81457: "0x2D509190Ed0172ba588407D4c2df918F955Cc6E1",
  534352: "0x3baD7AD0728f9917d1Bf08af5782dCbD516cDd96",
  7777777: "0x13fDac9F9b4777705db45291bbFF3c972c6d1d97",
};

/**
 * …and Across's MulticallHandler on each chain it delivers to (the same deployments), where a
 * deposit lands first when it carries calls to make there: a swap into what the card bought,
 * unwrapping the chain's coin, or passing on what a swap as it left bought (see assertArrival).
 */
const MULTICALL_HANDLERS: Readonly<Partial<Record<number, Address>>> = {
  1: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
  10: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
  56: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
  130: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
  137: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
  143: "0xeC41F75c686e376Ab2a4F18bde263ab5822c4511",
  232: "0x1Ed0D59019a52870337b51DEe8190486a8663037",
  324: "0x68d3806E57148D6c6793C78EbDDbc272fE605dbf",
  480: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
  999: "0x5E7840E06fAcCb6d1c3b5F5E0d1d3d07F2829bba",
  1135: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
  1868: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
  4217: "0x7D6ADCbB51Ea70C134d7B0B96aA9AF50FE504D90",
  4326: "0xFfc1285082deAB9bf0ECA5699e4930bb310aFbE4",
  5042: "0xA07480456C4EbaD7626e4FdF4a180709E238547b",
  8453: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
  9745: "0x5E7840E06fAcCb6d1c3b5F5E0d1d3d07F2829bba",
  34443: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
  42161: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
  43114: "0x9610954AcDCA5FF7905f051A040ce33fe613c60e",
  57073: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
  59144: "0xdF1C940487574EEfa79989a79a4936A0F979cDa2",
  81457: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
  534352: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
  7777777: "0x0F7Ae28dE1C8532170AD4ee566B5801485c13a0E",
};

/** Across's own contracts on `chainId`, which a bridge leaves through or lands from. */
export function acrossContracts(chainId: number): Address[] {
  return [SPOKE_POOLS[chainId], MULTICALL_HANDLERS[chainId]].filter(
    (contract) => contract !== undefined,
  );
}

/**
 * …and Circle's CCTP V2, which Across sends USDC through too: its TokenMessengerV2, at one address
 * on every EVM chain (developers.circle.com/cctp/evm-smart-contracts), and its program on Solana
 * (developers.circle.com/cctp/solana-programs).
 */
const CCTP_TOKEN_MESSENGER: Address = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
/** The first 8 bytes of sha256("global:deposit_for_burn"): Anchor's name for that instruction. */
const DEPOSIT_FOR_BURN = "d73c3d2e723780b0";
/**
 * Circle's domain for each chain Across sends CCTP to, by chain id (@across-protocol/constants
 * 3.1.130, as Circle lists them). BNB Chain isn't one: what CCTP mints there isn't the
 * Binance-Peg USDC Auni holds.
 */
const CCTP_DOMAINS: Readonly<Partial<Record<number, number>>> = {
  1: 0,
  10: 2,
  130: 10,
  137: 7,
  143: 15,
  480: 14,
  999: 19,
  5042: 26,
  8453: 6,
  9745: 33,
  42161: 3,
  43114: 1,
  57073: 21,
  59144: 11,
  [ACROSS_SOLANA_CHAIN_ID]: 5,
};

/** How Across's SpokePool hands a fill to the contract it lands with, as MulticallHandler takes it. */
const HANDLE_MESSAGE = parseAbi([
  "function handleV3AcrossMessage(address token, uint256 amount, address relayer, bytes message)",
]);
const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
/** MulticallHandler's message: the calls it makes, and who gets what's left if one fails. */
const INSTRUCTIONS = parseAbiParameters(
  "((address target, bytes callData, uint256 value)[] calls, address fallbackRecipient)",
);
const WRAPPED_NATIVE = parseAbi(["function wrappedNativeToken() view returns (address)"]);

const DEPOSITS = parseAbi([
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
  "event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)",
]);

/**
 * What a deposit's card promised of the other chain, which the deposit itself must say before
 * Auni signs it: the transaction Across built is signed as it came, so the only word for where
 * it pays out is what Across's SpokePool or Circle's CCTP logs or reads from it.
 */
interface Landing {
  readonly to: BridgeChain;
  /** Whose wallet it leaves, which a refund goes back to. */
  readonly depositor: string;
  /** Who gets it: the owner's own wallet, or a withdrawal's destination. */
  readonly recipient: string;
  /** What lands, by address or mint: the zero address for an EVM chain's own coin. */
  readonly token: string;
  /** What the deposit carries there: what lands, or for a chain's coin, its wrapped token. */
  readonly carried: string;
  /** The least of it that lands, in its units. */
  readonly least: bigint;
}

function refuse(what: string): never {
  throw new Error(`Across's deposit ${what}, so nothing was sent.`);
}

/** An EVM address or a Solana account as the 32 bytes a deposit names it by. */
const word = (account: string): Hex =>
  account.startsWith("0x")
    ? pad(account.toLowerCase() as Hex)
    : bytesToHex(new Uint8Array(getAddressEncoder().encode(address(account))));

const sameWord = (said: Hex, account: string) => said.toLowerCase() === word(account);

/**
 * Refuses an EVM deposit unless its venue logged exactly one in the simulation, landing what its
 * card promised: Across's SpokePool on the chain it leaves, or Circle's CCTP. Anyone else's word
 * for a deposit counts for nothing.
 */
async function assertEvmDeposit(
  chainId: number,
  logs: readonly Log[],
  landing: Landing,
): Promise<void> {
  const spokePool = SPOKE_POOLS[chainId];
  const said = logs.flatMap(({ address: from, data, topics }) => {
    const eventName =
      spokePool && isAddressEqual(from, spokePool)
        ? "FundsDeposited"
        : isAddressEqual(from, CCTP_TOKEN_MESSENGER)
          ? "DepositForBurn"
          : null;
    if (!eventName) return [];
    try {
      return [decodeEventLog({ abi: DEPOSITS, eventName, data, topics })];
    } catch {
      return [];
    }
  });
  const [deposit] = said;
  if (!deposit) refuse("isn't one Auni can find");
  if (said.length > 1) refuse("is split into several");
  if (deposit.eventName === "DepositForBurn") {
    const { amount, destinationDomain, mintRecipient, maxFee, hookData } = deposit.args;
    await assertBurn({ amount, destinationDomain, mintRecipient, maxFee, hookData }, landing);
    return;
  }
  const { args } = deposit;
  if (args.destinationChainId !== BigInt(acrossChainId(landing.to)))
    refuse("lands on another chain");
  if (!sameWord(args.depositor, landing.depositor)) refuse("would refund someone else");
  // It lands with Across's handler there, whose calls a simulation holds to the card, or with who
  // its card named, asked to run nothing there (only a contract would).
  const handler = MULTICALL_HANDLERS[acrossChainId(landing.to)];
  if (handler && sameWord(args.recipient, handler)) return assertArrival(args, handler, landing);
  if (!sameWord(args.recipient, landing.recipient)) refuse("pays someone else");
  if (args.message !== "0x") refuse("asks for calls on arrival");
  if (!sameWord(args.outputToken, landing.carried)) refuse("lands another token");
  if (args.outputAmount < landing.least) refuse("lands less than its card said");
}

/** The EVM address a deposit names by 32 bytes. */
const addressOf = (said: Hex): Address => getAddress(`0x${said.slice(-40)}`);

/**
 * Refuses a deposit landing with Across's MulticallHandler, which makes the calls Across put in
 * its message (a swap into what the card bought, say), unless those calls, simulated on the
 * chain it lands on with what the deposit carries already in the handler, as the SpokePool's
 * fill leaves it, land at least what its card promised with who it promised, take nothing of
 * theirs, and pay no one else but what a swap there spends: what the deposit carried, when it
 * isn't what lands. The handler takes its message from anyone, so the simulation sends it as a
 * relayer would, from an account of its own. Should a call fail at the fill, which no
 * simulation now can show, what's left goes to the message's fallback: nobody, so the fill
 * fails and Across refunds it, or who it lands with.
 */
async function assertArrival(
  deposit: {
    readonly outputToken: Hex;
    readonly outputAmount: bigint;
    readonly exclusiveRelayer: Hex;
    readonly message: Hex;
  },
  handler: Address,
  landing: Landing,
): Promise<void> {
  const fallback = (() => {
    try {
      return decodeAbiParameters(INSTRUCTIONS, deposit.message)[0].fallbackRecipient;
    } catch {
      return refuse("asks for calls Auni can't read on arrival");
    }
  })();
  if (!isAddressEqual(fallback, zeroAddress) && !sameDestination(fallback, landing.recipient))
    refuse("leaves what a failed call there doesn't spend to someone else");
  const chainId = acrossChainId(landing.to);
  const carried = addressOf(deposit.outputToken);
  const fill = encodeFunctionData({
    abi: HANDLE_MESSAGE,
    functionName: "handleV3AcrossMessage",
    args: [carried, deposit.outputAmount, addressOf(deposit.exclusiveRelayer), deposit.message],
  });
  // Never from who it lands with: at the fill a relayer sends it, so a call paying whoever sent
  // it (tx.origin) pays the relayer, yet sent from the wallet it would read as landing there. A
  // fresh account each time, so no call can tell the simulation by who sends it.
  const filler = privateKeyToAddress(generatePrivateKey());
  const simulated = await simulateEffect(
    chainId,
    getAddress(landing.recipient),
    [{ to: handler, data: fill }],
    {
      arriving: { token: carried, holder: handler, amount: deposit.outputAmount },
      from: filler,
    },
  ).catch(() => refuse("fails on arrival in a simulation"));
  if (!simulated) refuse("can't be checked on the chain it lands on");
  if (simulated.out.length > 0 || simulated.grants.length > 0)
    refuse("takes from who it lands with");
  const lands = landing.token === zeroAddress ? EVM_NATIVE : landing.token;
  const got = simulated.in.find((leg) => sameDestination(leg.token, lands))?.amount ?? 0n;
  if (got < landing.least) refuse("lands less than its card said");
  const spends = sameDestination(carried, lands) ? null : carried;
  // A chain's own coin lands unwrapped: its wrapped token leaves the handler for nobody, burnt
  // (Arbitrum's WETH logs that as a transfer to the zero address), and the coin comes back.
  const unwraps = landing.token === zeroAddress ? landing.carried : null;
  const elsewhere = simulated.logs.some(
    ({ address: token, topics: [event, from, to] }) =>
      event === TRANSFER &&
      from !== undefined &&
      to !== undefined &&
      sameWord(from, handler) &&
      !sameWord(to, landing.recipient) &&
      !(spends && isAddressEqual(token, spends)) &&
      !(unwraps && sameDestination(token, unwraps) && sameWord(to, zeroAddress)),
  );
  if (elsewhere) refuse("pays someone else on arrival");
}

/**
 * Refuses a card for a move Across finishes with calls on the chain it lands on (a swap into
 * what it buys, the chain's coin unwrapped) where Auni couldn't check those calls before signing
 * the deposit: execute simulates them there with what the deposit carries already landed (see
 * assertArrival), and a chain whose nodes can't run that (see arrivedState) would only refuse
 * after the tap. So the same simulation is tried now, of a read that does nothing.
 */
async function assertArrivalCheckable(
  to: BridgeChain,
  quoted: AcrossQuote,
  recipient: string,
  toName: string,
): Promise<void> {
  const crosses = quoted.steps?.bridge?.tokenOut?.address;
  if (to === "solana" || !crosses) return;
  const carried = getAddress(crosses);
  const chainId = acrossChainId(to);
  const handler = MULTICALL_HANDLERS[chainId];
  if (!handler) return;
  const read = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [handler] });
  const checkable = await simulateEffect(
    chainId,
    getAddress(recipient),
    [{ to: carried, data: read }],
    {
      arriving: { token: carried, holder: handler, amount: 1n },
      from: privateKeyToAddress(generatePrivateKey()),
    },
  ).catch(() => null);
  if (!checkable)
    throw new Error(
      `Across would finish this with a swap on ${toName}, and Auni can't check that swap there ` +
        "before the deposit is signed, so no card was made. Nothing is wrong with the owner's " +
        "money. Move USDC there as it is and trade it there, or buy it on another chain.",
    );
}

/**
 * Refuses a CCTP burn unless it mints USDC to who its card said on the chain it named, and
 * at least what it said once the most Circle's fast transfer takes is spent.
 */
async function assertBurn(
  burn: {
    readonly amount: bigint;
    readonly destinationDomain: number;
    readonly mintRecipient: Hex;
    readonly maxFee: bigint;
    readonly hookData: Hex;
  },
  landing: Landing,
): Promise<void> {
  const domain = CCTP_DOMAINS[acrossChainId(landing.to)];
  if (domain === undefined || burn.destinationDomain !== domain) refuse("lands on another chain");
  const usdc = knownUsdc(landing.to);
  if (!usdc || !sameDestination(usdc, landing.token)) refuse("lands another token");
  // On Solana CCTP mints to a token account: the recipient's own USDC account.
  const account =
    landing.to === "solana" ? await usdcAccountOf(landing.recipient) : landing.recipient;
  if (!sameWord(burn.mintRecipient, account)) refuse("pays someone else");
  if (burn.hookData !== "0x") refuse("asks for calls on arrival");
  if (burn.amount < burn.maxFee || burn.amount - burn.maxFee < landing.least)
    refuse("lands less than its card said");
}

/**
 * Refuses a deposit from Solana unless it is one of Circle's CCTP burns that does what its card
 * promised. Across builds it as CCTP's deposit_for_burn, whose arguments sit in the bytes the
 * wallet signs: 8 bytes naming it, then amount (u64), destination domain (u32), mint recipient
 * (32 bytes), destination caller (32 bytes), max fee (u64) and finality threshold (u32).
 */
async function assertSolanaDeposit(transaction: string, landing: Landing): Promise<void> {
  const burns = (() => {
    try {
      const { messageBytes } = getTransactionDecoder().decode(
        getBase64Encoder().encode(transaction),
      );
      const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
      // A legacy or v0 message, as Across builds; any newer layout is one Auni can't read here.
      if (!("instructions" in message)) return [];
      return message.instructions.filter(
        ({ programAddressIndex }) => message.staticAccounts[programAddressIndex] === CCTP_SOLANA,
      );
    } catch {
      return [];
    }
  })();
  const [burn] = burns;
  const data = burn?.data;
  if (!data || data.length !== 96 || bytesToHex(data.subarray(0, 8)) !== `0x${DEPOSIT_FOR_BURN}`)
    refuse("isn't one Auni can find");
  if (burns.length > 1) refuse("is split into several");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  await assertBurn(
    {
      amount: view.getBigUint64(8, true),
      destinationDomain: view.getUint32(16, true),
      mintRecipient: bytesToHex(data.subarray(20, 52)),
      maxFee: view.getBigUint64(84, true),
      hookData: "0x",
    },
    landing,
  );
}

/**
 * What a deposit carries to `to` for `token` to land, and its decimals, as that chain says, so
 * no quote can shrink the least it lands: the token itself, or for the chain's own coin, the
 * wrapped token Across's SpokePool there unwraps.
 */
async function carriedThere(
  to: BridgeChain,
  token: string,
): Promise<{ readonly carried: string; readonly decimals: number }> {
  if (to === "solana") {
    if (token !== SOLANA_USDC.mint) refuse("lands something other than USDC on Solana");
    return { carried: token, decimals: SOLANA_USDC.decimals };
  }
  const chainId = acrossChainId(to);
  const client = evmClient(chainId);
  const spokePool = SPOKE_POOLS[chainId];
  const carried =
    token !== zeroAddress
      ? getAddress(token)
      : spokePool
        ? await client.readContract({
            address: spokePool,
            abi: WRAPPED_NATIVE,
            functionName: "wrappedNativeToken",
          })
        : refuse("lands a coin Auni can't find Across's pool for");
  const decimals = await client.readContract({
    address: carried,
    abi: erc20Abi,
    functionName: "decimals",
  });
  return { carried, decimals };
}

/** The least a move of `sent` USDC lands, as its card says: all but BRIDGE_LOSS_BPS of it. */
function cashLeast(sent: string): string {
  return formatUnits((parseUnits(sent, 6) * (10_000n - BRIDGE_LOSS_BPS)) / 10_000n, 6);
}

/**
 * The least a deposit must land for Auni to sign it, in `decimals`: what its card said it gets at
 * least, or for USDC landing as USDC on a card that said only "about", all but BRIDGE_LOSS_BPS of it.
 */
function leastItLands(
  transfer: AcrossTransfer & { readonly outputToken: string },
  amount: string,
  decimals: number,
  approved: Approved | undefined,
): bigint {
  const floor = approved?.details[APPROVED_PROCEEDS];
  if (floor !== undefined) return parseUnits(floor, decimals);
  const leaves = transfer.inputToken?.address ?? knownUsdc(transfer.from);
  const fromUsdc = knownUsdc(transfer.from);
  const toUsdc = knownUsdc(transfer.to);
  if (
    !leaves ||
    !fromUsdc ||
    !toUsdc ||
    !sameDestination(leaves, fromUsdc) ||
    !sameDestination(transfer.outputToken, toUsdc)
  )
    throw new Error("This card doesn't say the least it lands. Nothing was sent.");
  return (parseUnits(amount, decimals) * (10_000n - BRIDGE_LOSS_BPS)) / 10_000n;
}

const APPROVE = toFunctionSelector("approve(address,uint256)");

/** Across may ask for an unlimited approval; Auni approves only what this transfer spends. */
function exactApproval(tx: AcrossTx, units: bigint): AcrossTx {
  if (!tx.data.startsWith(APPROVE)) return tx;
  const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data as `0x${string}` });
  const [spender, allowance] = args as readonly [`0x${string}`, bigint];
  if (allowance <= units) return tx;
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender, units],
  });
  return { ...tx, data };
}

/**
 * A fresh quote for moving money across to its recipient, as Auni signs it; exact input, so fees
 * come out of what arrives. Across reads Solana a little behind, so a USDC account just opened there (see
 * acrossSend) can read as missing: it refused one already final, and quoted it seconds later.
 * While it says so, this asks again, for up to a minute.
 */
async function quoteToSign(transfer: AcrossTransfer): Promise<AcrossQuote> {
  const usdc = knownUsdc(transfer.from);
  const token = transfer.inputToken ?? (usdc === null ? null : { address: usdc, decimals: 6 });
  if (!token) throw new Error("Name the token that leaves.");
  const { to } = transfer;
  const units = parseUnits(transfer.amount, token.decimals);
  const outputToken = transfer.outputToken ?? (await acrossToken(to, undefined)).address;
  const query = {
    originChainId: String(acrossChainId(transfer.from)),
    destinationChainId: String(acrossChainId(to)),
    inputToken: token.address,
    outputToken,
    amount: units.toString(),
    depositor: transfer.depositor,
    recipient: transfer.recipient,
    tradeType: "exactInput",
  };
  for (let tries = 1; ; tries += 1) {
    try {
      const fresh = await quote(query);
      return { ...fresh, approvalTxns: fresh.approvalTxns?.map((tx) => exactApproval(tx, units)) };
    } catch (error) {
      if (!String(error).includes("token account does not exist")) throw error;
      if (tries >= 20)
        throw new Error(
          "Solana is still getting this wallet ready to hold USDC. Nothing was sent, so try again in a minute.",
        );
      await sleep(3_000);
    }
  }
}

/**
 * Who a card's quote landing on Solana names: the account holding Across's SpokePool settings
 * there, whose own USDC account is the pool's vault, so always open, as the recipient's may not be yet (see
 * usdc-account.ts). What CCTP takes doesn't depend on who it mints to, so the card's figures are
 * the recipient's; acrossSend opens their account and quotes again for what it signs.
 */
const SOLANA_QUOTE_STAND_IN = "3tzNXZAnJaCVikmENJSnJFAzkAnediKTxH3ot9Hiwnkz";

/** A fresh quote for a card, which no one signs (see quoteToSign and SOLANA_QUOTE_STAND_IN). */
export async function acrossQuote(transfer: AcrossTransfer): Promise<AcrossQuote> {
  return quoteToSign(
    transfer.to === "solana" ? { ...transfer, recipient: SOLANA_QUOTE_STAND_IN } : transfer,
  );
}

/**
 * SOL a deposit from Solana spends. Across sends it through Circle's CCTP, whose program charges
 * the depositor rent for a new account holding the transfer's message (2,824,480 lamports, which
 * only the payer can reclaim, five days on). Across signs for that account up front, so a sponsor
 * can't pay for the deposit (its fee payer would void that signature) and the wallet pays that
 * rent and two signatures (10,000).
 */
const SOLANA_DEPOSIT_LAMPORTS = 2_834_480n;

/**
 * How the SOL a deposit from Solana needs is bought (see sol-top-up.ts), and what's left to send.
 * A wallet with a sponsor buys all the deposit spends with the Solana USDC it sends, like Across's
 * own fee coming out of what arrives, so SOL the owner holds, which a specialist's fills may count,
 * is never spent on it; only the minimum the wallet keeps comes from what's there, which is
 * nothing while there is no wallet yet (null). One that pays its own way pays from its own SOL,
 * as for every other move it makes, buying with its USDC on Monad only what it lacks, and sends it
 * all. On a card's run (`approved`) it spends what the card showed.
 */
async function solanaDepositFee(
  depositor: string | null,
  amount: string,
  approved?: Approved,
): Promise<{ topUp: SolTopUp | null; sends: string }> {
  const held = depositor
    ? (await solanaRpc<{ value: number }>("getBalance", [depositor, { commitment: "confirmed" }]))
        .value
    : 0;
  const keep = SOLANA_KEEP_LAMPORTS - BigInt(held);
  if (await paysOwnGas("solana")) {
    const short = SOLANA_DEPOSIT_LAMPORTS + keep;
    return { topUp: short > 0n ? await solForFees(short, { approved }) : null, sends: amount };
  }
  // Bought with some of the USDC the move sends, so its card pins it as within its own amount.
  const topUp = outOfWhatItSends(
    await solForFees(SOLANA_DEPOSIT_LAMPORTS + (keep > 0n ? keep : 0n), { approved }),
  );
  const units = parseUnits(amount, SOLANA_USDC.decimals);
  // A move that would spend half of itself on SOL is too small to be worth making.
  if (topUp.usdc * 2n > units)
    throw new Error("That's too little to move from Solana: its network fee would take half.");
  return { topUp, sends: formatUnits(units - topUp.usdc, SOLANA_USDC.decimals) };
}

/**
 * Buys the SOL a deposit from Solana needs (see solanaDepositFee), once Across has quoted what's
 * left, so a route it can't take, or a deposit landing less or elsewhere than its card said
 * (`landing` for what it sends), buys nothing.
 */
async function buyDepositSol(
  transfer: AcrossTransfer,
  wallets: Signer,
  approved: Approved | undefined,
  landing: (amount: string) => Landing,
): Promise<{ amount: string; txs: SentTx[] }> {
  const { topUp, sends } = await solanaDepositFee(transfer.depositor, transfer.amount, approved);
  const quoted = await quoteToSign({ ...transfer, amount: sends });
  if (approved) landsEnough(approved, quoted);
  await assertSolanaDeposit(quoted.swapTx.data, landing(sends));
  return { amount: sends, txs: topUp ? await topUpSol(wallets, topUp) : [] };
}

/**
 * Refuses a quote whose transaction lets less land than its card said it gets at least (see
 * assertApprovedProceeds): the least its swap holds once its slippage is spent, which on arrival
 * is held only when Across fills it, later and on another chain.
 */
function landsEnough(approved: Approved, quoted: AcrossQuote): void {
  assertApprovedProceeds(
    approved,
    BigInt(quoted.minOutputAmount ?? quoted.expectedOutputAmount),
    quoted.outputToken.decimals,
  );
}

/**
 * Quotes fresh and sends: from Solana, first the SOL the deposit needs, bought with some of what
 * it sends (see buyDepositSol); on EVM, exact-amount approvals Across says are still missing, in
 * one batch with the deposit, so none outlives a deposit that fails (on Ethereum, which can't
 * batch, each lands on its own). Across built every byte, so they're held to what Auni asked
 * before they're signed: simulated from the wallet, no more leaves than this transfer and no
 * permission is left behind (see assertBytesDo); and the deposit, as its own venue says it,
 * lands what its card promised on the other chain (see Landing), where `landed` reads it. With
 * `approved`, nothing goes once the fresh quote lands less than the card said it gets at least
 * (see assertApprovedProceeds).
 */
export async function acrossSend(
  asked: AcrossTransfer,
  wallets: Signer,
  approved?: Approved,
): Promise<{
  txs: SentTx[];
  quote: AcrossQuote;
  /** From Solana, Circle's account holding the deposit's rent for the wallet (see rent.ts). */
  rentHeld?: string | null;
}> {
  const transfer = {
    ...asked,
    outputToken: asked.outputToken ?? (await acrossToken(asked.to, undefined)).address,
  };
  const from = acrossChainId(transfer.from);
  if (from === acrossChainId(transfer.to))
    throw new Error("Pick two different chains to bridge between.");
  const { carried, decimals: decimalsLanding } = await carriedThere(
    transfer.to,
    transfer.outputToken,
  );
  const landing = (sent: string): Landing => ({
    to: transfer.to,
    depositor: transfer.depositor,
    recipient: transfer.recipient,
    token: transfer.outputToken,
    carried,
    least: leastItLands(transfer, sent, decimalsLanding, approved),
  });
  const { amount, txs } =
    transfer.from === "solana"
      ? await buyDepositSol(transfer, wallets, approved, landing)
      : { amount: transfer.amount, txs: [] };
  // CCTP mints USDC on Solana only into an account already open.
  if (transfer.to === "solana")
    txs.push(...(await openUsdcAccount(wallets, transfer.recipient, approved)));
  // Quoted again after the swap, whose wait a quote's transaction might not outlive.
  const fresh = await quoteToSign({ ...transfer, amount });
  const calls = [...(fresh.approvalTxns ?? []), fresh.swapTx];
  // Every transaction leaves from the origin wallet; anything else isn't this bridge.
  if (calls.some((call) => call.chainId !== from))
    throw new Error("Across quoted a transaction on another chain.");
  if (approved) landsEnough(approved, fresh);
  const token = transfer.inputToken?.address ?? knownUsdc(transfer.from);
  const decimals = transfer.inputToken?.decimals ?? 6;
  if (!token) throw new Error("Name the token that leaves.");
  const units = parseUnits(amount, decimals);
  // From Solana the deposit is one transaction, which Across built and partly signed; the
  // wallet adds its own signature and pays its own way, as a sponsor's fee payer would void Across's.
  if (transfer.from === "solana") {
    const simulated = await simulateSolana(fresh.swapTx.data, address(transfer.depositor), {
      othersSigned: true,
      paysOwnFee: true,
    });
    assertBytesDo(simulated.effect, {
      gives: [
        { token, amount: units },
        { token: WRAPPED_SOL, amount: SOLANA_DEPOSIT_LAMPORTS },
      ],
      gets: [],
    });
    await assertSolanaDeposit(fresh.swapTx.data, landing(amount));
    const hash = await wallets.sendSolanaTransaction(fresh.swapTx.data, { paysOwnFee: true });
    txs.push({ chain: "solana", hash });
    return { txs, quote: fresh, rentHeld: rentHeldBy(fresh.swapTx.data, transfer.depositor) };
  }
  const batch: EvmTx[] = calls.map(({ to, data, value }, index) => ({
    to,
    data,
    ...(value && value !== "0" ? { value } : {}),
    ...(index < calls.length - 1 ? { setup: true as const } : {}),
  }));
  const coin = BigInt(fresh.swapTx.value ?? "0");
  const simulated = await simulateEffect(from, getAddress(transfer.depositor), batch).catch(
    (error: unknown) => {
      throw depositRefusal(error);
    },
  );
  assertBytesDo(simulated, {
    gives: [{ token, amount: units }, ...(coin > 0n ? [{ token: EVM_NATIVE, amount: coin }] : [])],
    gets: [],
  });
  await assertEvmDeposit(from, simulated?.logs ?? [], landing(amount));
  const hash = await wallets.sendEvmTransaction(from, batch);
  txs.push({ chain: chainKey(from), hash });
  return { txs, quote: fresh };
}

/** Where Across is with a deposit. */
interface DepositStatus {
  readonly status: "pending" | "filled" | "slowFillRequested" | "expired" | "refunded";
  /** The relayer's transaction that delivered it, once filled. */
  readonly fillTxnRef?: string | null;
  /** The transaction that gave it back on the chain it left, once refunded. */
  readonly depositRefundTxnRef?: string | null;
}

/**
 * The transaction that delivered a settled deposit, filled or refunded, so
 * its arrival is known as this move's (see arrivals.ts); none while neither.
 */
function delivered(deposit: DepositStatus): { delivered: string } | Record<string, never> {
  const hash = deposit.status === "refunded" ? deposit.depositRefundTxnRef : deposit.fillTxnRef;
  return hash ? { delivered: hash } : {};
}

/** The buy a filled deposit made: what execute kept of what arrives, for the dollars it spent. */
function boughtThere(action: Pick<ActionRow, "run" | "amountUsd">): Fill {
  const { arrivesChain, arrivesToken, arrivesQuantity } = action.run;
  if (!arrivesChain || !arrivesToken || !arrivesQuantity)
    throw new Error("Its send kept nothing of what arrives.");
  return {
    chain: arrivesChain as FillChain,
    instrument: arrivesToken,
    side: "buy",
    quantity: arrivesQuantity,
    usdValue: action.amountUsd,
  };
}

/** Auni's own cash: USDC in the owner's wallet where Auni spends it (see Network.cash). */
function spendsCash(bridge: {
  from_chain: string;
  from_token?: string | undefined;
}): FundingChain | null {
  const from = bridgeChain(bridge.from_chain);
  return typeof from !== "number" && isCash(from) && usdcOn(from, bridge.from_token) !== null
    ? from
    : null;
}

/** Where USDC lands as Cash, when it does; anything else arrives as a holding. */
function cashLanding(to: BridgeChain, outputToken: string | undefined): CashKey | null {
  if (typeof to === "number" || !isCash(to)) return null;
  const usdc =
    outputToken === undefined || outputToken.toLowerCase() === NETWORKS[to].usdc.toLowerCase();
  return usdc ? to : null;
}

/** A token leaving, as the holding its fills name. */
function heldToken(from: BridgeChain, token: AcrossToken): FillKey {
  if (from === "solana") return solanaMintKey(token.address);
  return evmTokenKey(typeof from === "number" ? chainKey(from) : from, token.address);
}

/** What a quote says lands, as the card writes it: in dollars when it lands as Cash. */
function arriving(quoted: AcrossQuote, asCash: boolean): string {
  const count = Number(
    formatUnits(BigInt(quoted.expectedOutputAmount), quoted.outputToken.decimals),
  );
  return asCash ? usdLabel(count) : `${formatAmount(count)} ${quoted.outputToken.symbol}`;
}

/**
 * The least a card says lands, which execute holds a fresh quote's least to (see landsEnough): a
 * slippage under this quote's, since a swap's least sits a slippage under what it expects, and
 * Across quotes no narrower slippage than its own to keep it once the price moves at all.
 */
function leastLanding(quoted: AcrossQuote): string {
  const expected = BigInt(quoted.expectedOutputAmount);
  const min = BigInt(quoted.minOutputAmount ?? quoted.expectedOutputAmount);
  return formatUnits((min * min) / expected, quoted.outputToken.decimals);
}

/**
 * A token Across swaps to USDC as it leaves, landing as Cash, reads as the sale it is, as a
 * swap's sale does: what comes back (`returnsUsd`) is its one figure, and what the way costs
 * against the token's market price, Across's fee and the swap's price together, is said beside
 * it rather than left as the gap between two figures. It gathers cash rather than spending it,
 * so its amountUsd counts as convert_to_cash's does: the least it lands, which a card's funding
 * and Portfolio's "On the way" read: the least it lands (see leastLanding).
 */
function homeSale(sale: {
  readonly from: BridgeChain;
  readonly token: AcrossToken;
  readonly amount: string;
  readonly quoted: AcrossQuote;
  readonly fromName: string;
  readonly toName: string;
  /** The SOL its wallet buys to open its USDC account on Solana (see openUsdcAccount). */
  readonly topUp: SolTopUp | null;
}): ActionPreview {
  const { from, token, amount, quoted, toName, topUp } = sale;
  const { decimals } = quoted.outputToken;
  const least = leastLanding(quoted);
  const atLeast = centsToUsd(parseUnits(least, 2));
  const back = Number(formatUnits(BigInt(quoted.expectedOutputAmount), decimals));
  const cost = token.priceUsd ? Number(amount) * Number(token.priceUsd) - back : 0;
  const held = heldToken(from, token);
  const sell = `${formatAmount(Number(amount))} ${token.symbol}`;
  return withTopUp(
    {
      // Nothing here weighs how much the route loses, as a swap's checks do, so it always asks.
      unpriced: "no price",
      summary:
        token.symbol === "USDC"
          ? `Move ${sell} from ${sale.fromName} to ${toName}`
          : `Sell ${sell} on ${sale.fromName} for USDC on ${toName}`,
      amountUsd: atLeast,
      sells: { ...held, quantity: amount },
      effect: {
        gives: [
          {
            text: `${sell} on ${sale.fromName}`,
            ...(token.priceUsd ? { usd: Number(amount) * Number(token.priceUsd) } : {}),
          },
        ],
        gets: [{ text: `at least ${dollars(atLeast)} of USDC`, lands: `on ${toName} ${LANDS_IN}` }],
        grants: [],
        costs: cost > 0 ? [{ label: "in the bridge's fee and the price it moves", usd: cost }] : [],
      },
      details: {
        [APPROVED_PROCEEDS]: least,
        sell,
        returnsUsd: usd(back),
        ...(cost > 0 ? { feeUsd: usd(cost) } : {}),
        fromToken: token.address,
        // What it sells, so its card wears that token's logo.
        chain: held.chain,
        mint: token.address,
        token: token.symbol,
      },
    },
    topUp,
  );
}

/** What lands: output_token, or USDC on the destination when none is named. */
async function arrivalToken(to: BridgeChain, outputToken: string | undefined): Promise<string> {
  if (outputToken) return outputToken;
  return (await acrossToken(to, undefined)).address;
}

/** The owner's own wallet on a chain, which a bridge leaves from and lands in. */
function ownWallet(chain: BridgeChain, wallet: string | null): string {
  if (!wallet) throw new Error(noAddressOn(chain === "solana" ? "Solana" : "EVM"));
  return wallet;
}

export const acrossBridge: Recipe<typeof input> = {
  tool: "bridge_usdc",
  venue: "across",
  description:
    "Move money into the owner's own wallet on another chain through Across (usually under a " +
    "minute), arriving as USDC unless output_token says otherwise. It takes USDC between " +
    "Auni's chains and Solana, either way (e.g. USDC they sent in on Base, to Solana for a " +
    "stock, or what a Solana stock sale left back to Monad). From Auni cash it " +
    "also buys a token on any other chain Across reaches, in one card, with Across paying the gas " +
    "there (WPRL on Ethereum). It brings any priced token home from any chain it supports, swapped to USDC as it leaves: USDG " +
    "someone sent to their address on Robinhood Chain, or selling WPRL it bought on Ethereum " +
    "(from_token its address, to_chain monad). Auni sets the recipient, so it is one tap. From " +
    "Solana it moves only USDC, and a little of it buys the SOL Solana's network charges for it. " +
    "A move stays running until it lands, and this thread is woken then with what landed, so " +
    "never sleep or poll to check on it.",
  input,
  fundedFrom: ({ input: bridge }) => spendsCash(bridge),
  // What arrives, when it's named; else USDC, the owner's cash.
  about: ({ details }) => tradedToken(details, 0) ?? { kind: "cash", at: "wallet" },
  // Only Auni cash arriving as something other than Cash buys a holding; everything else is
  // money changing places.
  direction: (bridge) =>
    spendsCash(bridge) && !cashLanding(bridgeChain(bridge.to_chain), bridge.output_token)
      ? "buy"
      : null,
  readies: (bridge) => cashLanding(bridgeChain(bridge.to_chain), bridge.output_token),
  async describe({ from_chain, to_chain, from_token, amount, output_token }) {
    const from = bridgeChain(from_chain);
    const to = bridgeChain(to_chain);
    const cash = spendsCash({ from_chain, from_token });
    // Its network fee may be bought with the USDC it sends (see buyDepositSol).
    if (from === "solana" && !cash)
      throw new Error("From Solana only USDC bridges: sell anything else to USDC first.");
    const [token, fromName, toName] = await Promise.all([
      acrossToken(from, from_token),
      chainLabel(from),
      destinationLabel(to),
    ]);
    // Read only when a move needs them, since the local dev account has none.
    const wallet = async (chain: BridgeChain) =>
      ownWallet(chain, await (chain === "solana" ? solanaAddress() : evmAddress()));
    // From Solana a little USDC may buy the SOL its network charges (see buyDepositSol), and to
    // Solana the SOL that opens the wallet's USDC account there (see openUsdcAccount).
    const { topUp, sends } =
      from === "solana"
        ? await solanaDepositFee(await solanaAddress(), amount)
        : {
            topUp: to === "solana" ? await solToOpen(await wallet(to), await wallet(to)) : null,
            sends: amount,
          };
    const buys = !cashLanding(to, output_token);
    const swaps = buys || !cash;
    // Where the wallet pays its own gas, core checks it can pay for what this would send.
    const chainId =
      typeof from === "number" ? from : from === "solana" ? null : NETWORKS[from].viem.id;
    const paysGas = chainId !== null && (await paysOwnGas(chainId));
    // A swap on the way, as something other than USDC leaves or lands, is quoted now: one its fees would
    // swallow is no card, and the card says what lands, since a small one can lose much of
    // itself on the way. A move of cash is quoted too where the wallet pays the gas, for the
    // transactions whose gas it checks.
    const quoted =
      swaps || paysGas
        ? await acrossQuote({
            from,
            to,
            amount: sends,
            inputToken: token,
            depositor: await wallet(from),
            recipient: await wallet(to),
            outputToken: await arrivalToken(to, output_token),
          })
        : null;
    // The calls it would send now, whose fee core checks the wallet can pay (ActionPreview.sends).
    const sending =
      quoted && chainId !== null && paysGas
        ? { sends: { chainId, calls: [...(quoted.approvalTxns ?? []), quoted.swapTx] } }
        : {};
    // What lands as something other than Cash, Across swaps or unwraps there, which execute checks.
    if (quoted && buys) await assertArrivalCheckable(to, quoted, await wallet(to), toName);
    // A holding going home to land as Cash is sold, whether Across swaps it as it leaves or,
    // like USDC where Auni doesn't spend it, carries it as it is (see homeSale).
    if (quoted && !cash && !buys)
      return { ...homeSale({ from, token, amount, quoted, fromName, toName, topUp }), ...sending };
    // The quote that prices a swap on the way, which a move of cash has none of.
    const swapQuote = swaps ? quoted : null;
    const value = cash
      ? normalizeUsd(amount)
      : token.priceUsd
        ? normalizeUsd((Number(amount) * Number(token.priceUsd)).toFixed(6))
        : "0";
    const sent = cash ? dollars(value) : `${formatAmount(Number(amount))} ${token.symbol}`;
    const arrival =
      output_token !== undefined && buys && swapQuote
        ? ` as ${swapQuote.outputToken.symbol}`
        : cash
          ? ""
          : " as USDC";
    // The SOL bought is on the card as every purchase of a fee's coin is: SOL for fees, most of
    // which stays in the wallet, never a network fee (see withTopUp).
    return withTopUp(
      {
        // Nothing here prices what a swap on the way gets or weighs how much the route loses,
        // as a swap's checks do, so it always asks, even in a specialist that acts on its own.
        ...(swapQuote ? { unpriced: "no price" as const } : {}),
        ...sending,
        summary: `Move ${sent}${cash ? " of USDC" : ""} from ${fromName} to ${toName}${arrival}`,
        amountUsd: value,
        // A holding leaving rather than cash, named so the card says whose and nothing else sells it too.
        ...(cash ? {} : { sells: { ...heldToken(from, token), quantity: amount } }),
        // What arrives lands on the other chain, where Auni reads it back (see landed).
        effect: {
          gives: [
            {
              text: `${sent}${cash ? " of USDC" : ""} on ${fromName}`,
              ...(cash || !token.priceUsd ? {} : { usd: Number(value) }),
            },
          ],
          gets: [
            {
              text: swapQuote
                ? `about ${arriving(swapQuote, false)}`
                : `about ${dollars(normalizeUsd(sends))} of USDC`,
              lands: `on ${toName} ${LANDS_IN}`,
            },
            // The SOL Circle holds for its message, which this card's tap gets back (rent.ts).
            ...(from === "solana" ? [await rentBack()] : []),
          ],
          grants: [],
        },
        details: {
          fromToken: token.address,
          // Where it lands, so the card's steps can say where it's on its way to.
          arrivesOn: toName,
          // The least it lands, which execute holds its fresh quote to: a swap's on the way, or
          // all but the most a move of cash may lose (see BRIDGE_LOSS_BPS), which a card's
          // funding counts as arriving.
          [APPROVED_PROCEEDS]: swapQuote ? leastLanding(swapQuote) : cashLeast(sends),
          // What arrives, so its card wears that token's logo.
          ...(output_token
            ? {
                chain: to === "solana" ? to : chainKey(acrossChainId(to)),
                mint: output_token,
                ...(swapQuote ? { token: swapQuote.outputToken.symbol } : {}),
              }
            : {}),
        },
      },
      topUp,
    );
  },
  async execute({
    action,
    input: { from_chain, to_chain, amount, output_token },
    wallets,
  }): Promise<ExecuteResult> {
    const from = bridgeChain(from_chain);
    const to = bridgeChain(to_chain);
    const own = (chain: BridgeChain) =>
      ownWallet(chain, chain === "solana" ? wallets.solanaAddress : wallets.evmAddress);
    const depositor = own(from);
    const recipient = own(to);
    const outputToken = await arrivalToken(to, output_token);
    const inputToken = await acrossToken(from, pinnedToken(action, "fromToken"));
    const {
      txs,
      quote: fresh,
      rentHeld,
    } = await acrossSend(
      { from, to, amount, inputToken, depositor, recipient, outputToken },
      wallets,
      action,
    );
    // Its card said the SOL Circle holds comes back, so its tap gets it back once Circle allows.
    const later = rentHeld
      ? [
          {
            tool: RECLAIM_TOOL,
            input: { account: rentHeld },
            summary: RECLAIM_SUMMARY,
            at: new Date(Date.now() + RENT_HELD_MS),
          },
        ]
      : [];
    const arrives = formatUnits(BigInt(fresh.expectedOutputAmount), fresh.outputToken.decimals);
    // A token Across swaps as it leaves is sold in the deposit itself, so its fill is the sale
    // the card named, whatever lands after: a refund gives back what it was swapped into. One
    // it bridges as it is, a refund gives back as itself, so that sells nothing.
    const sold = (usdValue: string): Fill[] =>
      fresh.steps?.originSwap
        ? [{ ...heldToken(from, inputToken), side: "sell", quantity: amount, usdValue }]
        : [];
    // Arriving USDC is Cash, on its way until Across fills it (see landed); only something
    // else arriving buys something a specialist can hold.
    if (cashLanding(to, output_token)) {
      return {
        txs,
        fills: sold(arrives),
        run: { lands: `${arriving(fresh, true)} on ${await chainLabel(to)}` },
        later,
      };
    }
    // What it buys is recorded only once Across fills it, since a refund buys nothing (see
    // landed), so what arrives is kept for then.
    const bought =
      to === "solana"
        ? solanaMintKey(outputToken)
        : evmTokenKey(chainKey(acrossChainId(to)), outputToken);
    return {
      txs,
      fills: sold(action.amountUsd),
      run: {
        lands: `about ${arriving(fresh, false)} on ${await chainLabel(to)}`,
        arrivesChain: bought.chain,
        arrivesToken: bought.instrument,
        arrivesQuantity: arrives,
      },
      later,
    };
  },
  async landed({ input: { from_chain, to_chain, output_token }, action }) {
    const sent = action.txs.findLast((tx) => !tx.setup && tx.hash);
    if (!sent?.hash) return null;
    const from = bridgeChain(from_chain);
    // A deposit's reference is its transaction: a hash on an EVM chain, a signature on Solana.
    const deposit = await across<DepositStatus>("deposit/status", {
      originChainId: String(acrossChainId(from)),
      depositTxnRef: sent.hash,
    });
    if (deposit.status === "filled") {
      if (cashLanding(bridgeChain(to_chain), output_token)) return delivered(deposit);
      return { ...delivered(deposit), bought: [boughtThere(action)] };
    }
    // Expired is refunded next, so it waits for that.
    if (deposit.status === "refunded")
      return {
        note: `Across couldn't deliver it, so it went back to ${await chainLabel(from)}.`,
        ...delivered(deposit),
      };
    return null;
  },
};
