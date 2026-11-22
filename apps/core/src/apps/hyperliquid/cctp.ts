import { NETWORKS } from "@auni/shared";
import {
  concatHex,
  encodeFunctionData,
  erc20Abi,
  pad,
  parseAbi,
  parseUnits,
  stringToHex,
  toHex,
  type Address,
  type Hex,
} from "viem";

import type { EvmTx } from "../../money/recipe.ts";
import { info } from "./api.ts";

// Circle's CCTP, the way a deposit into Hyperliquid goes (transfers.ts), and the one
// Hyperliquid's docs prefer for USDC into its account: nothing sent on it is lost for being small.
//
//   the wallet on Arbitrum          Circle                     HyperEVM                Hyperliquid
//   burns its USDC, naming   --->   attests the burn   --->    mints it to Circle's    credits the owner's
//   the forwarder and the           (seconds)                  forwarder, which        account, less the
//   owner's own account                                        sends it on             forwarding fee
//
// Everything that decides where the money goes is in the burn, on Arbitrum, where the owner's
// wallet signs it: the forwarder as the mint's recipient and as the only caller that may
// deliver it, and the owner's own address in the data the forwarder reads. Circle's guide says
// a burn that names anyone else for either is lost for good, so they are constants here.
// The addresses are Circle's published ones (developers.circle.com/cctp/references/
// contract-addresses and hypercore-contract-addresses, read 2026-11-13).

/** Circle's TokenMessengerV2 on Arbitrum, which burns the USDC it is approved for. */
export const TOKEN_MESSENGER: Address = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
/** Circle's CctpForwarder on HyperEVM: where the USDC is minted, and who alone may deliver it. */
export const FORWARDER: Address = "0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757";
/** Circle's CoreDepositWallet on HyperEVM, which Hyperliquid's ledger names as the sender of each credit. */
const CORE_DEPOSIT_WALLET = "0x6b9e773128f453f5c2c60935ee2de2cbc5390a24";
/** CCTP's numbers for the two chains. */
const ARBITRUM_DOMAIN = 3;
const HYPEREVM_DOMAIN = 19;
/** The least a deposit carries, in dollars. Under a dollar, the fee would be a fifth of it or more. */
export const MINIMUM_DEPOSIT_USD = 1;
/** A burn attested within seconds (CCTP's Fast Transfer), which costs nothing more on this route. */
const FAST = 1000;

const IRIS = "https://iris-api.circle.com/v2";
const TIMEOUT_MS = 15_000;

const messengerAbi = parseAbi([
  "function depositForBurnWithHook(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold, bytes hookData)",
]);

async function iris<Answer>(path: string): Promise<Answer | null> {
  const response = await fetch(`${IRIS}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  // A burn Circle has not seen yet is a 404, not an error.
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Circle could not answer (HTTP ${response.status}).`);
  return (await response.json()) as Answer;
}

/**
 * What the forwarder reads to know where the USDC goes on: "cctp-forward" in 24 bytes, a
 * version (0), the length of what follows (24), then the Hyperliquid account to credit and
 * which of its balances (0 is the perps balance, which a unified account spends as one with
 * its spot USDC).
 */
export function forwardHook(account: Address): Hex {
  return concatHex([
    stringToHex("cctp-forward", { size: 24 }),
    toHex(0, { size: 4 }),
    toHex(24, { size: 4 }),
    account,
    toHex(0, { size: 4 }),
  ]).toLowerCase() as Hex;
}

/**
 * What Circle keeps of `amount` (USDC units) for carrying it into Hyperliquid, as it quotes now:
 * its flat forwarding fee ($0.20 on 2026-11-13) and its share of a fast burn, which is nothing
 * on this route.
 */
export async function forwardingFee(amount: bigint): Promise<bigint> {
  const quoted = await iris<
    readonly {
      readonly finalityThreshold: number;
      /** In hundredths of a percent of the amount. */
      readonly minimumFee: number;
      readonly forwardFee: { readonly low: number; readonly med: number; readonly high: number };
    }[]
  >(`/burn/USDC/fees/${ARBITRUM_DOMAIN}/${HYPEREVM_DOMAIN}?forward=true&hyperCoreDeposit=true`);
  const fast = quoted?.find(({ finalityThreshold }) => finalityThreshold === FAST);
  if (!fast) throw new Error("Circle did not quote a fee for moving USDC into Hyperliquid.");
  const { low, med, high } = fast.forwardFee;
  // Hundredths of a percent, to two places: rounded up, so the fee named is never too little.
  const share = BigInt(Math.ceil(fast.minimumFee * 100));
  return BigInt(Math.max(low, med, high)) + (amount * share + 999_999n) / 1_000_000n;
}

/**
 * The two calls that send `amount` of the owner's USDC on Arbitrum into their own Hyperliquid
 * account, which go as one transaction: an approval of exactly the amount, which the burn then
 * uses up, and the burn. `maxFee` is the most Circle may keep of it.
 */
export function burnCalls(owner: Address, amount: bigint, maxFee: bigint): EvmTx[] {
  const forwarder = pad(FORWARDER).toLowerCase() as Hex;
  return [
    {
      to: NETWORKS.arbitrum.usdc,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [TOKEN_MESSENGER, amount],
      }),
      setup: true,
    },
    {
      to: TOKEN_MESSENGER,
      data: encodeFunctionData({
        abi: messengerAbi,
        functionName: "depositForBurnWithHook",
        args: [
          amount,
          HYPEREVM_DOMAIN,
          forwarder,
          NETWORKS.arbitrum.usdc,
          forwarder,
          maxFee,
          FAST,
          forwardHook(owner),
        ],
      }),
    },
  ];
}

/** What Circle says of the burn in one Arbitrum transaction: whether it was carried on, and what it kept. */
interface Burned {
  readonly messages?: readonly {
    readonly forwardState?: string;
    readonly decodedMessage?: {
      readonly decodedMessageBody?: { readonly feeExecuted?: string };
    } | null;
  }[];
}

/** One line of the account's ledger, as far as a deposit reads it. */
interface LedgerLine {
  readonly time: number;
  readonly hash: string;
  readonly delta: {
    readonly type: string;
    readonly user?: string;
    readonly destination?: string;
    readonly token?: string;
    readonly amount?: string;
  };
}

/**
 * Whether a burn has been credited, by two records that must agree. Circle says of this very
 * transaction that the forwarder carried it on, and what it kept. Hyperliquid's ledger shows
 * the credit: USDC from Circle's deposit wallet to the owner, of exactly what was sent less
 * what Circle kept, after the burn. The ledger names no Arbitrum transaction, so on its own it
 * could not tell two deposits of one amount apart; Circle's word for this transaction does.
 */
export async function credited(sent: {
  readonly hash: string;
  readonly owner: string;
  readonly amount: bigint;
  readonly since: number;
}): Promise<{ readonly delivered: string } | null> {
  const burned = await iris<Burned>(`/messages/${ARBITRUM_DOMAIN}?transactionHash=${sent.hash}`);
  const [message] = burned?.messages ?? [];
  const kept = message?.decodedMessage?.decodedMessageBody?.feeExecuted;
  if (message?.forwardState !== "COMPLETE" || kept === undefined) return null;
  const lands = sent.amount - BigInt(kept);
  const ledger = await info<readonly LedgerLine[]>({
    type: "userNonFundingLedgerUpdates",
    user: sent.owner,
    startTime: sent.since,
  });
  const credit = ledger.find(
    ({ delta }) =>
      delta.type === "send" &&
      delta.user?.toLowerCase() === CORE_DEPOSIT_WALLET &&
      delta.destination?.toLowerCase() === sent.owner.toLowerCase() &&
      delta.token === "USDC" &&
      delta.amount !== undefined &&
      parseUnits(delta.amount, 6) === lands,
  );
  return credit ? { delivered: credit.hash } : null;
}
