import { formatEther, type Address, type PublicClient } from "viem";

import { delegatedTo } from "./account-code.ts";
import { chainKey, evmClient } from "./chains.ts";
import { formatAmount } from "./format.ts";
import type { EvmSend, EvmTx } from "./recipe.ts";
import { Refused } from "./refused.ts";
import { asSent } from "./wallets.ts";

/** What EIP-7702 charges a transaction for each authorization it carries. */
const AUTHORIZATION_GAS = 25_000n;

/**
 * The gas limit a send carries: a quarter over the node's estimate of that very transaction.
 * A wallet signs with this limit and ownGas judges the wallet's balance by it, so what Auni says
 * a send needs and what the send asks for are one figure, on every chain: a chain may charge for
 * what the calls use or, as Monad does, for the whole limit, and either way a node takes the
 * send only when the wallet can pay for its limit.
 *
 * Nothing is signed to ask. Where the send delegates the account, the node estimates it with the
 * account's code already that (a state override) and the authorization's own charge is added:
 * within 200 gas of the estimate of the signed send on every chain Auni supports, and right where
 * a public RPC drops a signed authorization from its estimate (Polygon's did; probed November
 * 2026).
 */
export async function gasLimit(
  client: PublicClient,
  owner: Address,
  send: EvmSend,
): Promise<bigint> {
  const estimate = await client.estimateGas({
    account: owner,
    to: send.to,
    ...(send.data ? { data: send.data } : {}),
    value: send.value,
    ...(send.delegates
      ? { stateOverride: [{ address: owner, code: delegatedTo(send.delegates) }] }
      : {}),
  });
  return ((estimate + (send.delegates ? AUTHORIZATION_GAS : 0n)) * 5n) / 4n;
}

/**
 * The gas a send with this limit is charged for. Most chains charge what its calls use. One that
 * charges a send for its whole limit (Monad) reports the limit as the gas used, in a receipt and
 * in a simulation alike, so the chain is asked with the limit the send will carry and its answer
 * is the charge either way. A chain that can't simulate it is taken to charge the limit, the
 * most any chain does.
 */
async function chargedGas(
  client: PublicClient,
  owner: Address,
  send: EvmSend,
  limit: bigint,
): Promise<bigint> {
  const [block] = await client
    .simulateBlocks({
      blocks: [
        {
          calls: [
            {
              account: owner,
              to: send.to,
              ...(send.data ? { data: send.data } : {}),
              value: send.value,
              gas: limit,
            },
          ],
          ...(send.delegates
            ? { stateOverrides: [{ address: owner, code: delegatedTo(send.delegates) }] }
            : {}),
        },
      ],
    })
    .catch(() => []);
  const used = block?.calls[0]?.gasUsed;
  if (used === undefined) return limit;
  // Half of an authorization's charge comes back once it runs, as the sender's account exists.
  const charged = used + (send.delegates ? AUTHORIZATION_GAS / 2n : 0n);
  return charged < limit ? charged : limit;
}

/** What a send the wallet pays for costs it, as the chain says now. */
interface Cost {
  /** The chain's coin and the chain, as a person reads them: "MON", "Monad". */
  readonly coin: string;
  readonly chain: string;
  readonly balance: bigint;
  /** What the wallet must hold for a node to take the send: its gas limit, at the fee cap it offers. */
  readonly forGas: bigint;
  /** The coin the calls themselves send. */
  readonly value: bigint;
  /** What it most likely pays: the gas it is charged for, at this block's fee and the tip. */
  readonly fee: bigint;
}

/**
 * What the one transaction the wallet would send for these calls costs (see asSent in
 * wallets.ts), or null when the wallet or the chain can't say.
 */
async function cost(chainId: number, owner: Address, txs: readonly EvmTx[]): Promise<Cost | null> {
  let client: PublicClient;
  try {
    client = evmClient(chainId);
  } catch {
    return null;
  }
  const read = await (async () => {
    const send = await asSent(chainId, owner, txs);
    if (!send) return null;
    const [limit, fees, balance] = await Promise.all([
      gasLimit(client, owner, send),
      ownGasFees(chainId),
      client.getBalance({ address: owner }),
    ]);
    return { limit, fees, balance, charged: await chargedGas(client, owner, send, limit) };
  })().catch(() => null);
  if (!read) return null;
  const { limit, fees, balance, charged } = read;
  return {
    coin: client.chain?.nativeCurrency.symbol ?? "the chain's coin",
    chain: client.chain?.name ?? chainKey(chainId),
    balance,
    forGas: limit * fees.maxFee,
    value: txs.reduce((sum, tx) => sum + BigInt(tx.value ?? "0"), 0n),
    fee: charged * (fees.baseFee + fees.tip),
  };
}

/** A node takes a send only from a wallet that holds its gas at the fee cap, and the coin it sends. */
const cantPay = ({ balance, forGas, value }: Cost) => balance < forGas + value;

/**
 * What a send the wallet pays for costs in gas, about, and what it is short, said to the agent
 * before a card is shown, with what would fit first; or `short` null when the wallet can pay: a
 * send it can't is one no node accepts (a wallet may even report it broadcast). It is costed as
 * the wallet would send it (see gasLimit), so a card never asks for more than its send will.
 * `lacks` is the coin it is short, in wei, which a card may buy first (see fee-coin.ts).
 * When the wallet or the chain can't say, this is null and the send is left to the wallet.
 */
export async function ownGas(
  chainId: number,
  owner: Address,
  txs: readonly EvmTx[],
): Promise<{ short: string | null; fee: bigint; lacks?: bigint } | null> {
  const costs = await cost(chainId, owner, txs);
  if (!costs) return null;
  const { coin, chain, balance, forGas, value, fee } = costs;
  if (!cantPay(costs)) return { short: null, fee };
  // A send of the coin itself, such as selling it, fits by sending less of it, leaving room
  // for fees to rise a quarter before the tap, unless what it sends is a set price, as a
  // mint's is; anything else needs more of the coin there.
  const most = balance - (forGas * 5n) / 4n;
  const fix =
    value > 0n && most > 0n
      ? `send at most about ${formatEther(most)} ${coin} and still pay it, or, if that is a set price, bridge more ${coin} there first.`
      : `bridge a few dollars of their cash there as ${coin} first, then propose this again.`;
  const sends = value > 0n ? `, beyond the ${formatEther(value)} ${coin} it sends` : "";
  return {
    short:
      `Too little ${coin} for gas: ${fix} The wallet holds ${formatEther(balance)} ${coin} on ` +
      `${chain}, and this needs about ${formatEther(forGas)} ${coin} ` +
      `on hand for gas${sends}. It spends well under that; the rest stays in the wallet.`,
    fee,
    lacks: forGas + value - balance,
  };
}

/**
 * Stops a send the wallet can't pay for, before anything is signed: a wallet app calls it as
 * it is about to send. What it throws is the move's receipt, so it names the coin the fee is
 * paid in and how much of it, as the owner reads it, rather than "not enough money".
 */
export async function assertOwnGas(
  chainId: number,
  owner: Address,
  txs: readonly EvmTx[],
): Promise<void> {
  const costs = await cost(chainId, owner, txs);
  if (!costs || !cantPay(costs)) return;
  const { coin, chain, balance, forGas, value } = costs;
  const of = (wei: bigint) => `${formatAmount(Number(formatEther(wei)))} ${coin}`;
  const sends = value > 0n ? ` beyond the ${of(value)} it sends` : "";
  throw new Refused(
    "funds",
    `Nothing was sent: too little ${coin} for the network fee. The wallet holds ${of(balance)} ` +
      `on ${chain}, and this needs about ${of(forGas)} on hand${sends}.`,
  );
}

/**
 * The gas a move Auni sends may carry, which stands for the next moves before they are known: a
 * stock buy on Monad, an approval and a swap as one send, carried 1,391,135, and the first of
 * them, which also delegated the account, 897,013 (a new wallet's first two moves, November 2026).
 */
const MOVE_GAS = 1_500_000n;
/** The moves the chain's coin left in the wallet is kept for: under that, a card tops it up. */
const RUNWAY_MOVES = 3n;

type GasFees = Awaited<ReturnType<typeof ownGasFees>>;

/**
 * What the chain's coin left in the wallet after a card's moves there lacks of what the next
 * few moves need on hand (RUNWAY_MOVES of MOVE_GAS at today's fee cap), in wei, for a card to
 * buy (see fee-coin.ts): 0n when it keeps enough, null when the chain can't say. `spends` is
 * what the card's moves charge, at the fees of now. Without that coin a wallet that pays its own
 * fees can send nothing there, so it is kept before it runs out, while it still pays for the
 * send that buys more.
 */
export async function runwayLacks(
  chainId: number,
  owner: Address,
  spends: (fees: GasFees) => bigint,
): Promise<bigint | null> {
  const read = await Promise.all([
    evmClient(chainId).getBalance({ address: owner }),
    ownGasFees(chainId),
  ]).catch(() => null);
  if (!read) return null;
  const [balance, fees] = read;
  const lacks = RUNWAY_MOVES * MOVE_GAS * fees.maxFee - (balance - spends(fees));
  return lacks > 0n ? lacks : 0n;
}

/** What `moves` moves like MOVE_GAS charge at these fees: a card's moves, before they are built. */
export const movesCharge =
  (moves: number) =>
  ({ baseFee, tip }: GasFees): bigint =>
    BigInt(moves) * MOVE_GAS * (baseFee + tip);

/**
 * What a send the wallet pays for offers per gas. The node suggests no tip,
 * and builders pass over a send with none once blocks fill, so it tips what
 * the middle sender in recent blocks did. The cap adds twice the next base
 * fee, so a rising fee doesn't strand it.
 */
export async function ownGasFees(
  chainId: number,
): Promise<{ tip: bigint; baseFee: bigint; maxFee: bigint }> {
  const history = await evmClient(chainId).getFeeHistory({
    blockCount: 10,
    rewardPercentiles: [50],
  });
  const tips = (history.reward ?? []).map(([tip]) => tip ?? 0n).sort((a, b) => (a < b ? -1 : 1));
  const tip = tips[tips.length >> 1] ?? 0n;
  const baseFee = history.baseFeePerGas.at(-1);
  if (baseFee === undefined) throw new Error("The chain didn't say its base fee.");
  return { tip, baseFee, maxFee: baseFee * 2n + tip };
}
