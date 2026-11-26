import { NETWORKS } from "@auni/shared";
import { address } from "@solana/kit";
import { erc20Abi, getAddress } from "viem";

import { assertBytesDo, type Approved } from "./approved.ts";
import { publicClient, SOLANA_USDC, solanaTokenBalance } from "./chains.ts";
import {
  pinned,
  SWAPPED,
  symbol,
  unpaidSays,
  withFeeCoin,
  withoutFeeCoin,
  type FeeCoin,
} from "./fee-coin-said.ts";
import { WRAPPED_SOL } from "./fill-key.ts";
import { formatAmount, usdLabel } from "./format.ts";
import {
  FeesUnpaid,
  NothingMoved,
  type ActionPreview,
  type SentTx,
  type Signer,
} from "./recipe.ts";
import { payInCalls, payInQuote, payInSettled, type PayInQuote } from "./pay-in.ts";
import { simulateSolana } from "./solana-effect.ts";
import { solUsd } from "./token-feeds.ts";
import { formatUnits } from "./usd.ts";
import { ownGas } from "./gas.ts";
import { Refused } from "./refused.ts";
import { noAddressOn, paysOwnGas, walletAddresses } from "./wallets.ts";

// Apps top up SOL through this file, and the registry loads every app, so the Solana route
// is looked up when first asked for: a load-time import here would load all of them first.
const firstSolanaRoute = async () => {
  const [first] = (await import("../apps/registry.ts")).filling("solana");
  if (!first) throw new Error("No app provides a Solana swap route to buy SOL with.");
  return { name: first.about.name, route: first.part };
};

/** The tool that moves cash between chains, by the name the agent calls it. */
const bridgeTool = async () =>
  (await import("../apps/registry.ts")).firstBridge().bridge.recipe.tool;

// A Solana transaction the wallet pays the fee and rent of pays from its own SOL, which most
// wallets here hold none of. Before one goes, the SOL it is short is bought, and its card shows
// the USDC that buys it as SOL for fees, most of which stays in the wallet for later moves:
//
//   a wallet with a sponsor           its Solana USDC -> SOL, in a swap the sponsor pays for
//   one that pays its own way         its Monad USDC -> SOL at its Solana address, paid in
//   (local keys)                        (pay-in.ts), since with no SOL it couldn't pay for that
//                                       swap either; it pays that send's gas in MON
//
// SOL is priced by the token feeds, as the portfolio prices it, so it is priced however the
// Solana route is set up. The card keeps the purchase it showed, and execute spends exactly that
// or nothing, however the price or the fee moved since: no card, no top-up.
//
// It is the same purchase as the coin an EVM chain's fees are paid in (fee-coin.ts), put on
// its card the same way (withTopUp, fee-coin-said.ts) and bought through the same door, the wallet a move
// is handed (payingFees): so it is made at most once for a card, whatever happens after, counts
// in a specialist's pot and a plan's sums, and is said by every drawing of the card. What keeps
// the two apart is only who finds the shortage: an EVM move says the calls it would send and
// core costs them, while each move on Solana simulates its own transaction, since what it is
// short there is rent as well as the fee, and its bytes are built again once the SOL has come.

/**
 * SOL bought for a Solana transaction's fees and rent: the purchase its card pins, the USDC it
 * costs, and what it was sized for (SolNeed).
 */
export type SolTopUp = SolNeed &
  (
    | { readonly via: "swap"; readonly usdc: bigint; readonly bought: FeeCoin }
    | {
        readonly via: "pay-in";
        readonly usdc: bigint;
        readonly bought: FeeCoin;
        readonly quote: PayInQuote;
      }
  );

/**
 * What a purchase of SOL is sized for: the lamports the move is short, and the Solana USDC the
 * move itself spends, which buying its SOL there can't spend too (see solForFees).
 */
export interface SolNeed {
  readonly lamports: bigint;
  readonly spends: bigint;
}

/**
 * The card with its top-up on it, as every purchase of a fee's coin is put on one (withFeeCoin):
 * pinned, and said beside the move, never as a cost or a network fee, since what the move
 * doesn't spend of it stays in the wallet, which its words say. What it was sized for goes with
 * the card as it is prepared (ActionPreview.buysSol), so a card of several moves buys SOL once
 * (buyingSolOnce), unless it comes out of what the move sends.
 */
export function withTopUp(preview: ActionPreview, plan: SolTopUp | null): ActionPreview {
  if (!plan) return preview;
  const pinnedOn = withFeeCoin(preview, plan.bought);
  if (plan.bought.within) return pinnedOn;
  return { ...pinnedOn, buysSol: { lamports: plan.lamports, spends: plan.spends } };
}

/**
 * The legs of one card, buying SOL once. Every leg that needs SOL (ActionPreview.buysSol) has
 * it bought by one of them, sized for them all: the first in the earliest stage that needs it
 * (proposal-order.ts) that buys no other coin, since a move pins one purchase. That leg runs
 * ahead of the legs beside it in its stage (FeeCoin.ahead), and a later stage starts only once
 * the stage before it has run, so the SOL is in the wallet before any other leg needing it runs.
 * Those pin none: one still short as it runs sends nothing (topUpUsdc). Each leg keeps what it
 * needs itself, so this can run again on the legs as a card gains or loses some, and is said the
 * same: it runs as a card's legs are prepared (prepareLegs), so the cash a card is checked for
 * counts the one purchase, and again once the moves paying for it are on (keepingFees). A card
 * whose legs each buy their own, where buying it once can't be done now, keeps them; one where a
 * leg can't get SOL, as it buys another coin and none beside it can buy SOL, is no card, said
 * plainly.
 */
export async function buyingSolOnce<Leg extends { readonly preview: ActionPreview }>(
  legs: readonly Leg[],
  stageOf: (leg: Leg) => number,
): Promise<Leg[]> {
  const needing = legs.filter(({ preview }) => preview.buysSol);
  const ownPurchase = ({ preview }: Leg) => pinned(preview.details ?? {})?.chain === "solana";
  // One leg buying its own SOL, as it was made, is already bought once.
  if (needing.length === 0 || (needing.length === 1 && ownPurchase(needing[0]!))) return [...legs];
  const buysOther = needing.filter(({ preview }) => !buysSolHere(preview));
  const earliest = Math.min(...needing.map(stageOf));
  const host = needing.find((leg) => stageOf(leg) === earliest && buysSolHere(leg.preview));
  if (!host) throw new Error(noLegBuysSol(buysOther[0]!.preview));
  const sum = (pick: (need: SolNeed) => bigint) =>
    needing.reduce((total, { preview }) => total + pick(preview.buysSol!), 0n);
  const once = solForFees(
    sum(({ lamports }) => lamports),
    {
      spends: sum(({ spends }) => spends),
    },
  );
  const plan = await (needing.every(ownPurchase) ? once.catch(() => null) : once);
  if (!plan) return [...legs];
  const ahead = { ...plan, bought: { ...plan.bought, ahead: true as const } };
  return legs.map((leg) => {
    if (leg === host) {
      const buying = withTopUp(buyingNone(leg.preview), ahead);
      return { ...leg, preview: { ...buying, buysSol: leg.preview.buysSol! } };
    }
    return needing.includes(leg) ? { ...leg, preview: buyingNone(leg.preview) } : leg;
  });
}

/** Whether a card that needs SOL buys it itself, or nothing: any other coin it buys is its one. */
function buysSolHere(preview: ActionPreview): boolean {
  const bought = pinned(preview.details ?? {});
  return !bought || bought.chain === "solana";
}

/** Why a card whose move buys another coin for its fees can't get its SOL. */
function noLegBuysSol({ summary, details }: ActionPreview): string {
  const other = pinned(details ?? {});
  const coin = other ? `${symbol(other.chain)} on ${NETWORKS[other.chain].name}` : "another coin";
  return (
    `Nothing was recorded, and the owner saw nothing: "${summary}" buys ${coin} for its network ` +
    "fee and also needs SOL for Solana's, and a move buys one coin for its fees. Bring the cash " +
    "to Solana in a move from a chain whose fee coin the wallet holds, alone or beside this " +
    "one, or ask them to send a little SOL to their Solana address."
  );
}

/** The card without the SOL it would buy, which another leg of its card buys for it. */
function buyingNone(preview: ActionPreview): ActionPreview {
  return buysSolHere(preview) ? withoutFeeCoin(preview) : preview;
}

/**
 * The top-up of a move that pays for it out of the USDC it sends itself (a bridge out of
 * Solana), so its card says so and nothing counts it beside the card's amount (FeeCoin.within).
 */
export function outOfWhatItSends(plan: SolTopUp): SolTopUp {
  return { ...plan, bought: { ...plan.bought, within: true } };
}

/** The purchase of SOL with `usdc` of the wallet's USDC on `from`, through `by`. */
const buysSol = (from: FeeCoin["from"], token: string, usdc: bigint, by: string): FeeCoin => ({
  chain: "solana",
  from,
  token,
  amount: usdc,
  usd: Number(formatUnits(usdc, SOLANA_USDC.decimals)),
  by,
});

/** A pay-in is asked for at least a dollar: what's left over pays the wallet's next fees. */
const LEAST_PAY_IN_USDC = 1_000_000n;

/** The USDC `lamports` of SOL cost at `usdPrice`, in base units. */
const usdcFor = (lamports: bigint, usdPrice: number, over = 1) =>
  BigInt(Math.ceil((Number(lamports) / 1e9) * usdPrice * over * 10 ** SOLANA_USDC.decimals));

const sol = (lamports: bigint) => `${formatAmount(Number(formatUnits(lamports, 9)))} SOL`;
const dollars = (usdc: bigint) => usdLabel(Number(formatUnits(usdc, 6)));

export interface TopUpOptions {
  /** The Solana USDC the transaction itself sends, which a swap top-up can't spend too. */
  readonly spends?: bigint;
  /** The card a move runs on: its top-up spends what that showed (its pinned purchase) or nothing. */
  readonly approved?: Approved | undefined;
}

/**
 * The USDC a top-up spends: without a card, what buys `lamports` with a tenth over the price for
 * the swap's slippage and the price moving (and at least `least`); on a card's run, what the card
 * showed, refused with nothing sent when that no longer buys them at today's price.
 */
async function topUpUsdc(lamports: bigint, least: bigint, approved?: Approved): Promise<bigint> {
  const card = approved && pinned(approved.details);
  const shown = card?.chain === "solana" ? card.amount : undefined;
  if (approved && shown === undefined)
    throw new NothingMoved(
      "The wallet is short of SOL for Solana's network fees, and its card showed buying none, so nothing was sent. Propose it again.",
    );
  const usdPrice = await solUsd();
  if (shown === undefined) {
    const sized = usdcFor(lamports, usdPrice, 1.1);
    return sized > least ? sized : least;
  }
  if (usdcFor(lamports, usdPrice) > shown)
    throw new NothingMoved(
      `Solana's network fees cost more now than the ${dollars(shown)} its card showed, so nothing was sent. Propose it again.`,
    );
  return shown;
}

/**
 * How the wallet gets the `lamports` of SOL it's short of, as the wallet decides who pays (see
 * the top), or a plain error saying what would let it: money short, when the wallet holds too
 * little to buy it, so its card offers adding money.
 */
export async function solForFees(
  lamports: bigint,
  { spends = 0n, approved }: TopUpOptions = {},
): Promise<SolTopUp> {
  const { evm, solana } = await walletAddresses();
  if (!solana) throw new Error(noAddressOn("Solana"));
  const needs = `The wallet needs about ${sol(lamports)} for Solana's network fees and holds too little`;

  if (!(await paysOwnGas("solana"))) {
    const [usdc, held] = await Promise.all([
      topUpUsdc(lamports, 0n, approved),
      solanaTokenBalance(address(solana), SOLANA_USDC.mint, SOLANA_USDC.tokenProgram),
    ]);
    if (held < usdc + spends)
      throw new Refused(
        "funds",
        `${needs}, and too little USDC on Solana to buy it (about ${dollars(usdc)}). Move a ` +
          `little USDC to Solana with ${await bridgeTool()}, then propose it again.`,
      );
    const { name } = await firstSolanaRoute();
    const bought = buysSol("solana", SOLANA_USDC.mint, usdc, name);
    return { via: "swap", usdc, bought, lamports, spends };
  }

  const monad = NETWORKS.monad;
  const usdc = await topUpUsdc(lamports, LEAST_PAY_IN_USDC, approved);
  const held = evm
    ? await publicClient("monad").readContract({
        address: monad.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [getAddress(evm)],
      })
    : 0n;
  if (!evm || held < usdc)
    throw new Refused(
      "funds",
      `${needs}, and under ${dollars(usdc)} of USDC on Monad to buy it with. Ask them to send a ` +
        "little SOL to their Solana address, or USDC on Monad, which Auni turns into SOL as a " +
        "move needs it; then propose it again.",
    );
  const quote = await payInQuote({
    user: getAddress(evm),
    recipient: solana,
    from: { chain: "monad", token: getAddress(monad.usdc) },
    to: { chain: "solana", token: "native" },
    amount: usdc,
  });
  if (quote.least < lamports)
    throw new NothingMoved(
      `${quote.by} would bring at least ${sol(quote.least)} for ${dollars(usdc)} of USDC, under the ${sol(lamports)} it needs. Propose it again shortly.`,
    );
  const gas = await ownGas(monad.viem.id, getAddress(evm), depositCalls(quote));
  if (gas?.short) throw new Error(gas.short);
  const bought = buysSol("monad", getAddress(monad.usdc), usdc, quote.by);
  return { via: "pay-in", usdc, bought, quote, lamports, spends };
}

/**
 * The calls a top-up paid in sends, held to exactly two: an exact approval of the depository,
 * then one deposit there (payInQuote checked each against what was asked), both as setup and
 * marked as the card's purchase (payInCalls).
 */
function depositCalls(quote: PayInQuote) {
  const [approve, deposit, ...more] = quote.steps;
  if (approve?.id !== "approve" || deposit?.id !== "deposit" || more.length > 0)
    throw new Error(
      `${quote.by}'s quote for SOL isn't one approval and one deposit, so nothing was sent.`,
    );
  return payInCalls(quote);
}

/**
 * How the wallet buys the SOL `transaction`, simulated from `payer`, lacks (see solForFees), or
 * null when it holds enough or its sponsor pays: a transaction Auni built itself, which never
 * sends SOL, so only its fee and rent can be short.
 */
export async function solFor(
  transaction: string,
  payer: string,
  options: TopUpOptions = {},
): Promise<SolTopUp | null> {
  if (!(await paysOwnGas("solana"))) return null;
  const { short } = await simulateSolana(transaction, address(payer), { paysOwnFee: true });
  return short ? solForFees(short, options) : null;
}

/**
 * Buys the SOL `plan` says (see solForFees), waiting until it's in the wallet. The send that
 * buys goes through the wallet a move is handed marked as its card's purchase (EvmTx.buysFees),
 * so the card makes it once, ever (payingFees). A deposit the service then doesn't pay stops
 * the move as any purchase that didn't come does (FeesUnpaid), saying where the order stands.
 * The service says it paid once it has sent the SOL, which Solana's node, asked as a send is
 * simulated, may not show for a while yet: so the move goes on only once the wallet's SOL is
 * seen to rise there, or stops the same way, with the SOL still to come and nothing more bought.
 */
export async function topUpSol(wallets: Signer, plan: SolTopUp): Promise<SentTx[]> {
  if (plan.via === "swap") return [await buySol(wallets, plan.usdc)];
  const owner = address(wallets.solanaAddress);
  const before = await lamportsOf(owner);
  const hash = await wallets.sendEvmTransaction(NETWORKS.monad.viem.id, depositCalls(plan.quote));
  const { status } = await payInSettled(plan.quote.requestId);
  if (status !== "success") throw new FeesUnpaid(unpaidSays(plan.bought, status));
  if (!(await solShown(owner, before))) throw new FeesUnpaid(unpaidSays(plan.bought, "pending"));
  return [{ chain: "monad", hash, setup: true }];
}

/** How long Solana's node may take to show SOL the pay-in service says it paid. */
const SHOWN_WAIT_MS = 60_000;

/** The wallet's SOL, as a send's simulation reads it (see sendSolanaTransaction's preflight). */
const lamportsOf = (owner: ReturnType<typeof address>) =>
  solanaTokenBalance(owner, address(WRAPPED_SOL), SOLANA_USDC.tokenProgram);

/** Whether the wallet's SOL rises past `before` within SHOWN_WAIT_MS. */
async function solShown(owner: ReturnType<typeof address>, before: bigint): Promise<boolean> {
  const until = Date.now() + SHOWN_WAIT_MS;
  for (;;) {
    if ((await lamportsOf(owner).catch(() => before)) > before) return true;
    if (Date.now() > until) return false;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/**
 * Buys SOL with `usdc` of the wallet's Solana USDC (see topUpUsdc), kept as
 * a setup step, in a swap the wallet's sponsor pays for, on the first Solana
 * route. The route built the swap's bytes, so they're simulated from the
 * wallet first and held to it: that USDC out, at least the quote's SOL in.
 */
async function buySol(wallets: Signer, usdc: bigint): Promise<SentTx> {
  const taker = address(wallets.solanaAddress);
  const { route } = await firstSolanaRoute();
  const built = await route.build({
    inputMint: SOLANA_USDC.mint,
    outputMint: WRAPPED_SOL,
    amount: usdc,
    slippageBps: 100,
    taker,
  });
  assertBytesDo((await simulateSolana(built.transactionBase64, taker)).effect, {
    gives: [{ token: SOLANA_USDC.mint, amount: usdc }],
    gets: [{ token: WRAPPED_SOL, amount: built.quote.minOutAmount }],
  });
  const hash = await wallets.sendSolanaTransaction(built.transactionBase64, {
    setup: true,
    buysFees: SWAPPED,
  });
  return { chain: "solana", hash, setup: true };
}
