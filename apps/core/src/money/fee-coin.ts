import {
  EVM_CHAIN_KEYS,
  NETWORK_KEYS,
  NETWORKS,
  isCash,
  listed,
  type EvmCashKey,
  type EvmChainKey,
  type NetworkKey,
} from "@auni/shared";
import { and, gte } from "drizzle-orm";
import { erc20Abi, formatEther, getAddress, type Address, type Hex } from "viem";

import { db } from "../db/client.ts";
import { actions, type ActionRow } from "../db/schema.ts";
import { chainKey, evmClient, RESERVES } from "./chains.ts";
import {
  boughtFeesFor,
  paysWith,
  pinned,
  SWAPPED,
  symbol,
  unpaidSays,
  type FeeCoin,
} from "./fee-coin-said.ts";
import { EVM_NATIVE } from "./fill-key.ts";
import { movesCharge, ownGas, runwayLacks } from "./gas.ts";
import { payInCalls, payInQuote, payInSettled, payInStanding, type PayInQuote } from "./pay-in.ts";
import { readPortfolioShared, type Holding } from "./portfolio.ts";
import { STUCK_AFTER_MS } from "./readings.ts";
import {
  FeesUnpaid,
  NoFeeCoin,
  NothingMoved,
  type ActionPreview,
  type KeptTx,
  type EvmTx,
  type Signer,
} from "./recipe.ts";
import { keepTxs, LANDING_WINDOW_MS } from "./record.ts";
import { swapCalls, type EvmQuoteRequest, type EvmRoute } from "./swaps/evm.ts";
import { quoteSwap } from "./swaps/routes.ts";
import { feedListing } from "./token-feeds.ts";
import { evmAddress, paysOwnGas, type SignerOptions } from "./wallets.ts";

// A send the wallet pays for goes only with some of the chain's own coin there (ETH, POL, MON),
// and a wallet often holds cash on a chain and none of its coin: one brought home from hosted
// Auni holds none anywhere, since its provider paid every fee. So where a card's move is short
// of the coin, the card buys it first, as the SOL for Solana's fees is bought (sol-top-up.ts):
//
//   describe   the recipe says the calls its card would send (ActionPreview.sends); feeCoinFor
//              asks the chain what they cost and, where the wallet is short, plans the purchase
//              and withFeeCoin pins it on the card, no cost, but what execute is held to
//   execute    payingFees wraps the wallet for the move: a send still short of the coin first
//              sends exactly what the card showed, waits for the coin, and goes on
//
// A card buys once, on every chain. The send that buys is kept on its action as the purchase
// (KeptTx.buysFees) in the write that keeps the send itself, so however the run ends, and
// however often the move is run again, that card never buys a second time: a run that finds the
// purchase made and the coin still not there stops with nothing sent, saying where the service
// says the order stands (FeesUnpaid). The wallet a move is handed is the one door that holds
// this (payingFees), for the purchase made here and for SOL, which a move on Solana buys as it
// finds what it is short (sol-top-up.ts). What the card pins and says of its purchase is made in one place,
// fee-coin-said.ts, which every drawing of a card reads: the web's card and a plan's rows, a
// channel's copy, and what the agent is told.
//
// The coin is bought through the pay-in app (apps/order.ts) from a chain that can send now: one
// whose fees a sponsor pays, or where the wallet holds the coin. There it pays with USDC, or,
// where it holds too little USDC, with that chain's own coin. What is signed is an ordinary
// transaction the card's amount is the whole of: an exact approval and a deposit into the
// service's depository, or one deposit carrying the coin (pay-in.ts holds every quote to that).
// The service then pays the coin to the wallet's own address. That payout is its promise and
// not something the chain enforces, so what a card can lose to it is the purchase alone, which
// is kept small (MOST_USD) and said on the card.
//
// A chain where nothing can send now can't be helped this way, and a signed message can't
// start it either. USDC takes one (EIP-3009) and the shipped pay-in service carries those, but
// only between chains, and not from Monad. And USDC asks an address that runs account code
// (EIP-7702) to vouch for its own signature, which a wallet brought from hosted Auni answers
// only for one made in the wallet's own name, the kind a wallet app never signs
// (apps/wallet.md). Checked on each chain in November 2026. Those cases keep the refusal below,
// which says where fees can be paid and what is missing.
//
// So a wallet that holds some of the coin is kept from running out of it: once it is gone,
// nothing on that chain can move, and nothing there can buy more. Where a card's moves would
// leave the coin on a chain under what the next few moves there need (runwayLacks in gas.ts),
// the card first swaps a little of that chain's own USDC for it, on the chain itself, while the
// coin still pays for that swap. A swap rests on nobody, so it is how a card buys the coin
// wherever the chain's own cash can; the pay-in service is asked only for a move that can't go
// without the coin.
//
//   propose    keepingFees (actions.ts) asks topUpFor of each chain the card's moves send on
//              (ActionPreview.sends), and puts the swap on its first move there, where the
//              card's own sums still pay for it
//   execute    payingFees swaps exactly the card's USDC before that move's first send there, if
//              the send is short of the coin or would leave it low; one that can't be made by
//              then holds up only a move that can't go without it

/**
 * A purchase buys at least this much, a quarter of a dollar: what the move leaves pays the
 * wallet's next fees there, and under it the service's own fee (about 2.5 cents) is most of it.
 */
const LEAST_USD = 0.25;
/** ...and never more, so a card can lose only a few dollars to the service's promise. */
const MOST_USD = 5;
/** Bought over what the move is short, for the service's fee and a price that moves before the tap. */
const OVER = 1.5;
/** A swap that brings less of the coin than this share of its dollars' worth is passed over. */
const FAIR = 0.9;
/** How long the chain's node may take to show coin the service says it paid. */
const SHOWN_WAIT_MS = 30_000;

const idOf = (chain: EvmChainKey) => NETWORKS[chain].viem.id;
const isEvm = (chain: string): chain is EvmChainKey =>
  (EVM_CHAIN_KEYS as readonly string[]).includes(chain);

const isEvmCash = (chain: string): chain is EvmCashKey => isEvm(chain) && isCash(chain);

/**
 * A purchase this file plans and makes: an EVM chain's coin, paid from another EVM chain, or by
 * a swap of the chain's own USDC there.
 */
type Bought = FeeCoin & {
  readonly chain: EvmChainKey;
  readonly from: EvmChainKey;
  readonly token: Address | "native";
};
const onEvm = (bought: FeeCoin): bought is Bought => isEvm(bought.chain) && isEvm(bought.from);
const swapsThere = (bought: Bought) => bought.from === bought.chain;
/**
 * The purchase of the chain's coin that a card sending these calls needs, or null when the
 * wallet can pay for them as it stands, a sponsor pays, or nobody can say. Where it is short and
 * nothing can buy the coin, no card is made: this throws what the agent reads instead.
 */
export async function feeCoinFor({
  chainId,
  calls,
}: NonNullable<ActionPreview["sends"]>): Promise<FeeCoin | null> {
  const wallet = await evmAddress();
  if (!calls || !wallet || !(await paysOwnGas(chainId))) return null;
  const owner = getAddress(wallet);
  const gas = await ownGas(chainId, owner, calls);
  if (!gas?.short) return null;
  const chain = chainKey(chainId);
  const bought =
    isEvm(chain) && gas.lacks !== undefined
      ? await purchase(chain, owner, gas.lacks).catch(() => null)
      : null;
  if (!bought) throw await whereFeesArePaid(new NoFeeCoin(gas.short));
  return bought;
}

/**
 * The swap that keeps the chain's coin from running low for a card sending `moves` moves on
 * `chainId` (see the top), or null where the wallet pays no fees of its own there, what the coin
 * left after them pays for the next few, or the chain's own cash can't buy it now.
 */
export async function topUpFor(chainId: number, moves: number): Promise<FeeCoin | null> {
  const wallet = await evmAddress();
  const chain = chainKey(chainId);
  if (!wallet || !isEvmCash(chain) || !(await paysOwnGas(chainId))) return null;
  const owner = getAddress(wallet);
  const lacks = await runwayLacks(chainId, owner, movesCharge(moves));
  return lacks ? swapPurchase(chain, owner, lacks) : null;
}

/** Dollars of `chain`'s coin, in wei, at what a token feed says it is worth; throws with no price. */
async function coinFor(chain: EvmChainKey, usd: number): Promise<bigint> {
  const price = (await feedListing(chain, EVM_NATIVE))?.usdPrice;
  if (!price) throw new Error(`No price for ${symbol(chain)}.`);
  return BigInt(Math.ceil((usd / price) * 1e9)) * 10n ** 9n;
}

/**
 * The dollars a purchase of `lacks` of `chain`'s coin, in wei, spends: half as much again, and at
 * least LEAST_USD. Null with no price for the coin, or past what a purchase may spend.
 */
async function purchaseUsd(chain: EvmChainKey, lacks: bigint): Promise<number | null> {
  const price = (await feedListing(chain, EVM_NATIVE))?.usdPrice;
  if (!price) return null;
  const usd = Math.max(LEAST_USD, Number(formatEther(lacks)) * price * OVER);
  return usd > MOST_USD ? null : usd;
}

/**
 * How `lacks` of `chain`'s coin, in wei, is bought for `owner`: by a swap of the chain's own cash
 * where it can, else from the first chain that can send now and holds enough (see the top), in
 * the order Auni lists its chains, so from Monad where it can. Null when none can, or the move is
 * short of more than a purchase may buy.
 */
async function purchase(
  chain: EvmChainKey,
  owner: Address,
  lacks: bigint,
): Promise<FeeCoin | null> {
  const here = isEvmCash(chain) ? await swapPurchase(chain, owner, lacks).catch(() => null) : null;
  if (here) return here;
  const usd = await purchaseUsd(chain, lacks);
  if (usd === null) return null;
  for (const from of EVM_CHAIN_KEYS.filter((each) => each !== chain)) {
    const bought = await purchaseFrom(from, { chain, owner, lacks, usd }).catch(() => null);
    if (bought) return bought;
  }
  return null;
}

/** The purchase paid from `from`, with its USDC or else its own coin; null when it can't pay. */
async function purchaseFrom(
  from: EvmChainKey,
  want: {
    readonly chain: EvmChainKey;
    readonly owner: Address;
    readonly lacks: bigint;
    readonly usd: number;
  },
): Promise<FeeCoin | null> {
  const { chain, owner, lacks, usd } = want;
  const client = evmClient(idOf(from));
  const usdc = NETWORKS[from].usdc;
  const [own, coin, cash] = await Promise.all([
    paysOwnGas(idOf(from)),
    client.getBalance({ address: owner }),
    usdc
      ? client.readContract({
          address: getAddress(usdc),
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner],
        })
      : 0n,
  ]);
  // A chain where the wallet pays its own way and holds none of the coin can send nothing.
  if (own && coin === 0n) return null;
  const inUsdc = BigInt(Math.ceil(usd * 1e6));
  const pays: Pick<Bought, "token" | "amount"> | null =
    usdc && cash >= inUsdc
      ? { token: getAddress(usdc), amount: inUsdc }
      : own
        ? { token: "native", amount: await coinFor(from, usd) }
        : null;
  if (!pays) return null;
  // Coin that pays is beyond what the chain keeps in the wallet (see RESERVES) and its own gas.
  if (pays.token === "native" && coin < pays.amount + (RESERVES[from] ?? 0n)) return null;
  const quote = await quoted({ chain, from, ...pays }, owner);
  if (quote.least < lacks) return null;
  const gas = own ? await ownGas(idOf(from), owner, payInCalls(quote)) : null;
  if (gas?.short) return null;
  return { chain, from, ...pays, usd, by: quote.by };
}

/**
 * The purchase of `lacks` of `chain`'s coin by a swap of the chain's own USDC there, for `owner`,
 * or null where none can be made now: the wallet holds none of the coin to pay for the swap
 * itself, too little USDC, or no route brings enough for what the swap costs and its own fee.
 */
async function swapPurchase(
  chain: EvmCashKey,
  owner: Address,
  lacks: bigint,
): Promise<FeeCoin | null> {
  const [coin, cash, usd] = await Promise.all([
    evmClient(idOf(chain)).getBalance({ address: owner }),
    usdcOf(chain, owner),
    purchaseUsd(chain, lacks),
  ]);
  if (coin === 0n || usd === null) return null;
  const amount = BigInt(Math.ceil(usd * 1e6));
  if (cash < amount) return null;
  const request = coinSwap(chain, owner, amount);
  const route = await quoteSwap(request);
  if (!(await bringsEnough(route, chain, usd, lacks))) return null;
  const gas = await ownGas(idOf(chain), owner, await swapCalls(request, route, owner));
  if (!gas || gas.short) return null;
  return {
    chain,
    from: chain,
    token: getAddress(NETWORKS[chain].usdc),
    amount,
    usd,
    by: route.provider,
  };
}

/** A swap of `amount` of the chain's USDC for its own coin, paid to `owner`, as a route is asked for it. */
const coinSwap = (chain: EvmCashKey, owner: Address, amount: bigint): EvmQuoteRequest => ({
  chain,
  sellToken: getAddress(NETWORKS[chain].usdc),
  buyToken: EVM_NATIVE,
  sellAmount: amount,
  slippageBps: 100,
  taker: owner,
});

/**
 * Whether the least a route's swap brings covers what the wallet lacks, and is a fair price for
 * the `usd` it spends (FAIR of its worth at the token feed's price).
 */
async function bringsEnough(
  route: EvmRoute,
  chain: EvmChainKey,
  usd: number,
  lacks: bigint,
): Promise<boolean> {
  return route.minBuyAmount >= lacks && route.minBuyAmount >= (await coinFor(chain, usd * FAIR));
}

/** The wallet's USDC on `chain`, in base units. */
function usdcOf(chain: EvmCashKey, owner: Address): Promise<bigint> {
  return evmClient(idOf(chain)).readContract({
    address: getAddress(NETWORKS[chain].usdc),
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

/** The pay-in app's quote for a purchase, held to it (see pay-in.ts): paid to the wallet itself. */
function quoted(
  { chain, from, token, amount }: Pick<Bought, "chain" | "from" | "token" | "amount">,
  owner: Address,
): Promise<PayInQuote> {
  return payInQuote({
    user: owner,
    recipient: owner,
    from: { chain: from, token },
    to: { chain, token: "native" },
    amount,
  });
}

type Keep = SignerOptions["onSent"];

/**
 * The wallet a move is handed, which is the one door a card's purchase of a coin for its fees
 * goes through, on every chain. `signer` makes the move's wallet, keeping each send with the
 * `keep` it is handed.
 *
 * A send that buys the coin says so (EvmTx.buysFees, and the same on a Solana send): the calls
 * that deposit with the pay-in service, or a swap on the chain itself. Such a send is kept on
 * the action as its card's purchase, in the write that keeps the send, and a card makes one,
 * ever: where its action already keeps one (`card.txs`), or this run made one, a second is
 * refused with nothing signed, saying where the first stands (FeesUnpaid). A card that pinned
 * no purchase makes none at all.
 *
 * For an EVM chain's coin this also makes the purchase, since no recipe there knows of it: the
 * move's first send on that chain first buys it (see buy) where that send is short of the coin,
 * or, for a swap there, would leave it low (see the top). A send that is neither buys nothing,
 * so a card spends what it showed on fees or less. A swap for a send that can pay its own way
 * spends only USDC the move leaves (`spends` is the USDC the move itself spends there), and one
 * that can't be made by then lets the move go on without it. A move on Solana works out what it
 * is short itself and buys through this same door (sol-top-up.ts).
 */
export async function payingFees(
  card: Pick<ActionRow, "details" | "txs">,
  signer: (keep: Keep) => Promise<Signer>,
  keep: Keep,
  spends: { readonly chain: string; readonly usdc: bigint } | null = null,
): Promise<Signer> {
  const wallets = await signer(keep);
  const bought = pinned(card.details);
  // The purchase this card made: an earlier run's, kept with its send, or this run's.
  let made = card.txs.find((tx) => tx.buysFees)?.buysFees;
  const unmade = async () => {
    if (!bought)
      throw new NothingMoved(
        "The wallet is short of the coin its network fee is paid in, and its card showed buying none, so nothing was sent. Propose it again.",
      );
    if (!made) return;
    // Only the pay-in service has an order to ask after; a swap bought the coin or sent nothing.
    const order = made.startsWith("0x") ? (made as Hex) : null;
    const standing = order
      ? await payInStanding(order).catch(() => null)
      : { status: "success" as const };
    throw new FeesUnpaid(unpaidSays(bought, standing?.status ?? "pending"));
  };
  /** The wallet for the one send that buys: kept as this card's purchase, so no later run buys again. */
  const buyer = async (how: string) => {
    await unmade();
    made = how;
    return signer((sent, within) => keep({ ...sent, buysFees: how }, within));
  };
  const door: Signer = {
    ...wallets,
    async sendEvmTransaction(chainId, tx) {
      const txs = "to" in tx ? [tx] : tx;
      const how = txs.find((each) => each.buysFees)?.buysFees;
      if (!how) return wallets.sendEvmTransaction(chainId, tx);
      return (await buyer(how)).sendEvmTransaction(chainId, tx);
    },
    async sendSolanaTransaction(base64Tx, options) {
      if (!options?.buysFees) return wallets.sendSolanaTransaction(base64Tx, options);
      return (await buyer(options.buysFees)).sendSolanaTransaction(base64Tx, options);
    },
  };
  if (!bought || !onEvm(bought)) return door;
  const run = {
    bought,
    wallets: door,
    keep,
    spends: spends?.chain === bought.chain ? spends.usdc : 0n,
  };
  /** Buys before the move's first send on the purchase's chain, where that send needs it. */
  const before = async (chainId: number, txs: readonly EvmTx[]) => {
    const owner = getAddress(wallets.evmAddress);
    const gas = await ownGas(chainId, owner, txs);
    if (gas?.short) {
      // Said before anything is asked of anyone, so a card that bought says only that.
      await unmade();
      return buy({ ...run, lacks: gas.lacks ?? 0n });
    }
    // A send that can pay its own way buys only by a swap, and only where it leaves the coin low.
    if (!gas || made || !swapsThere(bought)) return;
    const value = txs.reduce((sum, each) => sum + BigInt(each.value ?? "0"), 0n);
    const lacks = await runwayLacks(chainId, owner, () => gas.fee + value);
    if (lacks)
      await buy({ ...run, lacks }).catch((error: unknown) =>
        console.warn(`The coin for ${NETWORKS[bought.chain].name}'s fees wasn't bought:`, error),
      );
  };
  let looked = false;
  return {
    ...door,
    async sendEvmTransaction(chainId, tx) {
      const txs = "to" in tx ? [tx] : tx;
      if (!looked && chainId === idOf(bought.chain) && !txs.some((each) => each.buysFees)) {
        looked = true;
        await before(chainId, txs);
      }
      return door.sendEvmTransaction(chainId, tx);
    },
  };
}

interface Purchase {
  readonly bought: Bought;
  /** What the send it is made for lacks of the coin, in wei: for itself, or for the moves after. */
  readonly lacks: bigint;
  /** The move's wallet, through whose door the purchase goes (see payingFees). */
  readonly wallets: Signer;
  readonly keep: Keep;
  /** The chain's USDC the move itself spends there, which a swap leaves for it. */
  readonly spends: bigint;
}

/** Makes the purchase a card pinned (see payingFees): a swap on the chain, or a deposit with the pay-in service. */
function buy(purchase: Purchase): Promise<void> {
  return swapsThere(purchase.bought) ? swapFor(purchase) : payIn(purchase);
}

/**
 * Swaps exactly the USDC the card showed for the chain's coin, there, in a send of its own marked
 * as the card's purchase, and returns once it landed. It throws with nothing sent where that USDC
 * is no longer there beside what the move spends, or no route brings a fair price for it that
 * covers what the send lacks.
 */
async function swapFor({ bought, lacks, wallets, spends }: Purchase): Promise<void> {
  const chain = bought.chain as EvmCashKey;
  const owner = getAddress(wallets.evmAddress);
  const coin = symbol(chain);
  if ((await usdcOf(chain, owner)) < bought.amount + spends)
    throw new NothingMoved(
      `The ${paysWith(bought)} its card showed swapping for ${coin} isn't there beside what the move spends, so nothing was sent. Propose it again.`,
    );
  const route = await quoteSwap(coinSwap(chain, owner, bought.amount));
  if (!route.send || !(await bringsEnough(route, chain, bought.usd, lacks)))
    throw new NothingMoved(
      `${coin} for ${NETWORKS[chain].name}'s network fees costs more now than the ` +
        `${paysWith(bought)} its card showed swapping for it, so nothing was sent. Propose it again.`,
    );
  await route.send(asPurchase(wallets));
}

/** The wallet a route's swap goes out through, each of its sends marked as the card's purchase. */
const asPurchase = (wallets: Signer): Signer => ({
  ...wallets,
  sendEvmTransaction: (chainId, tx) =>
    wallets.sendEvmTransaction(
      chainId,
      ("to" in tx ? [tx] : tx).map((call) => ({ ...call, setup: true, buysFees: SWAPPED })),
    ),
});

/**
 * Buys the coin a send is short of from another chain through the pay-in service, and waits for
 * it: exactly what the card showed is deposited, from where it showed, and only while the service
 * still brings at least what the send is short. It throws with nothing sent where the card's
 * amount no longer buys enough, and FeesUnpaid where the deposit went and the service didn't pay.
 */
async function payIn({ bought, lacks, wallets, keep }: Purchase): Promise<void> {
  const owner = getAddress(wallets.evmAddress);
  const coin = symbol(bought.chain);
  const quote = await quoted(bought, owner);
  if (quote.least < lacks)
    throw new NothingMoved(
      `${coin} for ${NETWORKS[bought.chain].name}'s network fee costs more now than the ` +
        `${paysWith(bought)} its card showed buying it with, so nothing was sent. Propose it again.`,
    );
  const client = evmClient(idOf(bought.chain));
  const before = await client.getBalance({ address: owner });
  await wallets.sendEvmTransaction(idOf(bought.from), payInCalls(quote));
  const { status, paidIn } = await payInSettled(quote.requestId);
  if (status !== "success") throw new FeesUnpaid(unpaidSays(bought, status));
  // What paid the wallet is the service's send, kept so its arrival is known as this move's own.
  for (const hash of paidIn) await keep(payout(bought.chain, hash, quote.requestId));
  // The service has paid; the send that follows asks this chain's node, which may be a block behind.
  const until = Date.now() + SHOWN_WAIT_MS;
  while (
    Date.now() < until &&
    (await client.getBalance({ address: owner }).catch(() => before)) <= before
  )
    await new Promise((resolve) => setTimeout(resolve, 1_000));
}

/** The service's transaction that paid the wallet for a purchase, as its action keeps it. */
const payout = (chain: string, hash: string, order: string): KeptTx => ({
  chain,
  // An EVM hash is hex, kept in one case; a Solana signature's case is its own.
  hash: chain === "solana" ? hash : hash.toLowerCase(),
  setup: true,
  buysFees: order,
});
/** Whether two hashes on `chain` are one transaction (see payout). */
const sameTx = (chain: string, a: string, b: string) =>
  chain === "solana" ? a === b : a.toLowerCase() === b.toLowerCase();

/**
 * The move whose card's purchase the transaction `txHash` pays out on `chain`, by the pay-in
 * service's own word for what paid the order: the service sends that transaction, so nothing of
 * the wallet's own names it. It is kept on the move from then on. A run keeps it itself as the
 * service answers (see buy), so this is asked only of a purchase with no payout kept yet: one
 * read before its run heard back, or paid after its move had failed for want of it. Null when
 * no such purchase is this transaction's; "unknown" while one made in the last half hour may be
 * and the service can't say yet, so whoever asks can wait rather than take the coin for money
 * the owner put in.
 */
export async function feeCoinPaidBy(
  chain: string,
  txHash: string,
): Promise<string | null | "unknown"> {
  const made = await db
    .select({ id: actions.id, txs: actions.txs, startedAt: actions.startedAt })
    .from(actions)
    .where(
      and(boughtFeesFor(chain), gte(actions.startedAt, new Date(Date.now() - LANDING_WINDOW_MS))),
    );
  let unknown = false;
  for (const { id, txs, startedAt } of made) {
    const order = txs.find((tx) => tx.buysFees)?.buysFees;
    // The purchase's deposit is on the chain that paid; a kept send on this one is its payout.
    if (!order || txs.some((tx) => tx.buysFees && tx.chain === chain)) continue;
    const standing = await payInStanding(order as Hex).catch(() => null);
    if (standing?.paidIn.some((hash) => sameTx(chain, hash, txHash))) {
      await keepTxs(db, id, [payout(chain, txHash, order)]);
      return id;
    }
    const recent = (startedAt?.getTime() ?? 0) > Date.now() - STUCK_AFTER_MS;
    if (recent && (!standing || standing.status === "pending")) unknown = true;
  }
  return unknown ? "unknown" : null;
}

/**
 * The networks where a move can pay its network fee now, as the top says the coin is found:
 * where a sponsor pays, where the wallet holds the chain's own coin, and, once some EVM chain
 * can send, every other EVM chain, whose coin is bought from there, and Solana, whose SOL is
 * bought with USDC on Monad once Monad can send (sol-top-up.ts). Money on any other network
 * can't move until some of a chain's coin arrives.
 */
export async function feesPayable(holdings: readonly Holding[]): Promise<NetworkKey[]> {
  const sponsored = await Promise.all(
    NETWORK_KEYS.map(async (key) => !(await paysOwnGas(NETWORKS[key].viem?.id ?? "solana"))),
  );
  const held = new Set(
    holdings
      .filter((holding) => holding.venue === "wallet" && holding.instrument === "native")
      .filter((holding) => Number(holding.quantity) > 0)
      .map((holding) => holding.chain),
  );
  const ready = new Set(NETWORK_KEYS.filter((key, index) => sponsored[index] || held.has(key)));
  const evmSends = EVM_CHAIN_KEYS.some((key) => ready.has(key));
  return NETWORK_KEYS.filter(
    (key) => ready.has(key) || (key === "solana" ? ready.has("monad") : evmSends),
  );
}

/**
 * What the agent reads for a move no purchase can pay the fee of (see the top), in place of a
 * card that would only fail after the tap: why, and beside it what would work: where moves can
 * pay their way now, and that money on a chain with none of its coin can't leave it until some
 * arrives.
 */
export async function whereFeesArePaid(refused: NoFeeCoin): Promise<Error> {
  const where = await feesNow().catch(() => null);
  return new Error(where ? `${refused.message} ${where}` : refused.message);
}

/**
 * The chains whose fees are paid for the wallet, those where it holds some of the chain's coin,
 * and those where it holds something but none of the coin, said for the agent.
 */
async function feesNow(): Promise<string> {
  const [portfolio, own] = await Promise.all([
    readPortfolioShared(),
    Promise.all(EVM_CHAIN_KEYS.map((key) => paysOwnGas(NETWORKS[key].viem.id))),
  ]);
  const inWallet = portfolio.holdings.filter((holding) => holding.venue === "wallet");
  const hasCoin = new Set(
    inWallet
      .filter((holding) => holding.instrument === "native" && Number(holding.quantity) > 0)
      .map((holding) => holding.chain),
  );
  const holdsSomething = new Set(inWallet.map((holding) => holding.chain));
  const paysOwn = EVM_CHAIN_KEYS.filter((_, index) => own[index]);
  const names = (keys: readonly EvmChainKey[]) => listed(keys.map((key) => NETWORKS[key].name));
  const sponsored = EVM_CHAIN_KEYS.filter((_, index) => !own[index]);
  const paying = paysOwn.filter((key) => hasCoin.has(key));
  const stuck = paysOwn.filter((key) => holdsSomething.has(key) && !hasCoin.has(key));
  const can = [
    paying.length > 0
      ? `the wallet holds some of the chain's own coin for fees on ${names(paying)}`
      : "the wallet holds none of any chain's own coin for fees",
    ...(sponsored.length > 0 ? [`fees are paid for it on ${names(sponsored)}`] : []),
  ].join(", and ");
  const coins = listed(
    stuck.map((key) => NETWORKS[key].viem.nativeCurrency.symbol),
    "or",
  );
  const cannot =
    stuck.length > 0
      ? ` What it holds on ${names(stuck)} can't leave until some of that chain's own coin (${coins}) arrives there, which the owner can send to their own address.`
      : "";
  return `Right now ${can}.${cannot} Propose moves that start where fees can be paid, or tell the owner what's missing.`;
}
