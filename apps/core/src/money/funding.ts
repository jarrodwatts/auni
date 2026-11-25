import { CASH_KEYS, NETWORKS } from "@auni/shared";
import { address } from "@solana/kit";
import { getAddress, type Address } from "viem";

import type { ActionRow } from "../db/schema.ts";
import { BRIDGE_LOSS_BPS } from "../apps/contract.ts";
import { chainCash, ledgerAt } from "../apps/registry.ts";
import { placeName, SOLANA_USDC, solanaTokenBalance } from "./chains.ts";
import { readPortfolioShared, type Holding } from "./portfolio.ts";
import { frees, stagedLeg, type StagedLeg } from "./proposal-order.ts";
import type { CashPlace, FundingChain } from "./recipe.ts";
import { evmBalance } from "./swaps/evm.ts";
import { dollars } from "./summaries.ts";
import { centsToUsd, usdToCents } from "./usd.ts";
import { walletAddresses } from "./wallets.ts";

interface Funding {
  readonly chain: FundingChain;
  /** The shortfall in dollars, e.g. "23.50". */
  readonly needUsd: string;
}

/** A leg as a plan's funding weighs it (see StagedLeg). */
type CashLeg = Pick<StagedLeg, "draws" | "lands" | "amountUsd" | "landsAtLeastUsd" | "feeCash">;

/** About what a move of cash out of Solana spends of itself on the SOL its network charges, in cents. */
const SOLANA_FEE_CENTS = 100n;

/** The least a bridge sending `sent` cents from `from` lands, as its card will say (see BRIDGE_LOSS_BPS). */
export function bridgeLands(sent: bigint, from: CashPlace): bigint {
  const carried = from === "solana" ? sent - SOLANA_FEE_CENTS : sent;
  return carried > 0n ? (carried * (10_000n - BRIDGE_LOSS_BPS)) / 10_000n : 0n;
}

/** What a bridge from `from` sends for at least `cents` to land (see bridgeLands). */
export function sendFor(cents: bigint, from: CashPlace): bigint {
  const kept = 10_000n - BRIDGE_LOSS_BPS;
  const carried = (cents * 10_000n + kept - 1n) / kept;
  return from === "solana" ? carried + SOLANA_FEE_CENTS : carried;
}

/**
 * What a move lands where it's going, in cents: what its card says it lands at least, for a
 * bridge between wallets (else the least such a card would say, see bridgeLands), and for an
 * account kept in a ledger of its app's own, all but the flat fee it keeps of every withdrawal.
 */
function landsCents(leg: CashLeg): bigint {
  const cents = usdToCents(leg.amountUsd);
  if (leg.draws && ledgerAt(leg.draws))
    return cents - usdToCents(String(withdrawalFeeUsd(leg.draws)));
  const source = bridgeSource(leg);
  if (!source) return cents;
  return leg.landsAtLeastUsd === undefined
    ? bridgeLands(cents, source)
    : usdToCents(leg.landsAtLeastUsd, "down");
}

/** What taking cash out of a ledger account (by its app's id) costs, in dollars. */
export function withdrawalFeeUsd(account: string): number {
  const cash = ledgerAt(account)?.account.cash;
  return cash?.kind === "ledger" ? cash.outFeeUsd : 0;
}

/** A chain short of what a plan spends there, in cents: what it holds, what the plan's own moves land there, and what it spends. */
interface Shortfall {
  readonly chain: FundingChain;
  readonly cents: bigint;
  readonly holds: bigint;
  readonly lands: bigint;
  readonly spends: bigint;
}

/**
 * Each chain whose planned USDC spend exceeds its wallet balance, once the
 * plan's own money moves have landed their cash, and by how many cents,
 * largest first. Chains missing from `held` couldn't be read, so they claim
 * no shortfall. A venue's account is never one: money can't be added there
 * directly, so its picks are covered when the card is proposed (see
 * uncoveredAccounts).
 */
function shortfalls(
  legs: readonly CashLeg[],
  held: ReadonlyMap<FundingChain, bigint>,
): Shortfall[] {
  const spent = netSpend(legs, { arrivals: false });
  const short: Shortfall[] = [];
  for (const [place, cents] of netSpend(legs)) {
    // `held` holds chains only, so a venue's account has no balance here and is never short.
    const chain = place as FundingChain;
    const holds = held.get(chain);
    const spends = spent.get(chain) ?? 0n;
    if (holds !== undefined && cents > holds)
      short.push({ chain, cents: cents - holds, holds, spends, lands: spends - cents });
  }
  return short.sort((a, b) => (b.cents > a.cents ? 1 : b.cents < a.cents ? -1 : 0));
}

/** The chain short by the most, which a card's payment covers. */
export function largestShortfall(
  legs: readonly CashLeg[],
  held: ReadonlyMap<FundingChain, bigint>,
): Funding | null {
  const [largest] = shortfalls(legs, held);
  return largest ? { chain: largest.chain, needUsd: centsToUsd(largest.cents) } : null;
}

/**
 * The largest shortfall said for the agent with the sum behind it, so it can see what was
 * counted: "Monad holds $1.33 of cash, this card's own moves land at least $1.00 more there
 * (...), and it spends $3.00 there: $0.67 short". Null when nothing is short.
 */
export function shortfallSaid(
  legs: readonly CashLeg[],
  held: ReadonlyMap<FundingChain, bigint>,
): string | null {
  const [short] = shortfalls(legs, held);
  if (!short) return null;
  const usd = (cents: bigint) => dollars(centsToUsd(cents));
  const lands =
    short.lands > 0n
      ? `, this card's own moves land at least ${usd(short.lands)} more there (what their cards say, after fees)`
      : "";
  return `${placeName(short.chain)} holds ${usd(short.holds)} of cash${lands}, and it spends ${usd(short.spends)} there: ${usd(short.cents)} short`;
}

/**
 * Where a move of cash between wallets sends from; null for anything else. Such
 * moves run alongside each other on a card.
 */
function bridgeSource({ draws, lands }: Pick<StagedLeg, "draws" | "lands">): FundingChain | null {
  return draws && lands && !ledgerAt(draws) && !ledgerAt(lands) ? (draws as FundingChain) : null;
}

/**
 * The plan's bridges out of a wallet holding nothing to send, by index:
 * they could only fail, and the card says what is short where they were
 * going. Cash a plan takes out of savings or a venue's account first counts as held.
 */
export function idleBridges(
  legs: readonly CashLeg[],
  sendable: ReadonlyMap<FundingChain, bigint>,
): number[] {
  const freed = new Map<CashPlace, bigint>();
  for (const leg of legs)
    if (leg.lands && frees(leg))
      freed.set(leg.lands, (freed.get(leg.lands) ?? 0n) + landsCents(leg));
  return legs.flatMap((leg, index) => {
    const source = bridgeSource(leg);
    const balance = source && sendable.get(source);
    if (!source || balance === undefined || balance === null) return [];
    const available = balance + (freed.get(source) ?? 0n);
    return bridgeLands(available, source) > 0n ? [] : [index];
  });
}

/**
 * What a plan spends from each place, less what its own moves land there, in
 * cents: each leg's own amount where it draws, and the cash its card spends
 * buying a chain's coin for its fee, where that is paid from (StagedLeg.feeCash).
 * A move lands less than it sends, by its fee (landsCents). With
 * `arrivals: false` nothing landed counts: what a place can send on while the
 * plan's own moves are still on their way to it.
 */
function netSpend(legs: readonly CashLeg[], { arrivals = true } = {}): Map<CashPlace, bigint> {
  const needed = new Map<CashPlace, bigint>();
  const spend = (place: CashPlace, usd: string) =>
    needed.set(place, (needed.get(place) ?? 0n) + usdToCents(usd, "up"));
  for (const leg of legs) {
    if (leg.draws) spend(leg.draws, leg.amountUsd);
    if (leg.feeCash) spend(leg.feeCash.from, leg.feeCash.usd);
    if (!leg.lands || !arrivals) continue;
    needed.set(leg.lands, (needed.get(leg.lands) ?? 0n) - landsCents(leg));
  }
  return needed;
}

/**
 * Whether a plan's waiting moves spend more cash in this place than they bring there, so cash
 * coming in there is money for them. A plan that only sells, or spends elsewhere, never is.
 */
export function spendsCashIn(legs: readonly CashLeg[], place: CashPlace): boolean {
  return (netSpend(legs).get(place) ?? 0n) > 0n;
}

/**
 * The first venue account a plan's picks there need more of than it holds and the
 * plan deposits, in dollars; null when they're all covered. Orders need a little
 * over their margin for the fee and price drift; a withdrawal takes exactly
 * what it names, and runs before any deposit lands, so withdrawals have to
 * fit what it holds now.
 */
export async function uncoveredAccounts(legs: readonly CashLeg[]): Promise<{
  readonly place: string;
  readonly holdsUsd: string;
  readonly shortUsd: string;
} | null> {
  const cents = (from: readonly Pick<StagedLeg, "amountUsd">[]) =>
    from.reduce((sum, leg) => sum + usdToCents(leg.amountUsd), 0n);
  const accounts = new Set(
    legs.flatMap((leg) => (leg.draws && ledgerAt(leg.draws) ? [leg.draws] : [])),
  );
  for (const place of accounts) {
    const fromHere = legs.filter((leg) => leg.draws === place);
    const withdrawn = cents(fromHere.filter((leg) => leg.lands !== null));
    const headroom = (cents(fromHere.filter((leg) => leg.lands === null)) * 3n) / 100n;
    const spent = (netSpend(legs).get(place) ?? 0n) + headroom;
    const needed = spent > withdrawn ? spent : withdrawn;
    if (needed <= 0n) continue;
    const held = await cashCents(place);
    if (held < needed)
      return { place, holdsUsd: centsToUsd(held), shortUsd: centsToUsd(needed - held) };
  }
  return null;
}

/**
 * The bridges that bring the account's own cash to a plan's shortfall: from
 * the wallets with the most left once the plan has spent there, largest first,
 * until it's covered or they run out. Each sends enough that the least it
 * lands covers its part (see bridgeLands), since the fee comes out of what lands. `held` is what each
 * wallet can send itself, never a prediction market's collateral (see walletCash).
 * When they fall short, the card pays the rest (see payingHoldings); null
 * when there's nothing to bring.
 */
export function bridgesFor(
  short: Funding,
  legs: readonly CashLeg[],
  held: ReadonlyMap<FundingChain, bigint>,
): Bridge[] | null {
  // Bridges on one card run side by side, so cash still on its way to a chain can't be sent on.
  const needed = netSpend(legs, { arrivals: false });
  const spares = CASH_KEYS.flatMap((chain) => {
    const balance = held.get(chain);
    if (chain === short.chain || balance === undefined) return [];
    const spare = balance - (needed.get(chain) ?? 0n);
    return bridgeLands(spare, chain) > 0n ? [{ chain, spare }] : [];
  }).sort((a, b) => (b.spare > a.spare ? 1 : b.spare < a.spare ? -1 : 0));
  let left = usdToCents(short.needUsd, "up");
  const bridges: Bridge[] = [];
  for (const { chain, spare } of spares) {
    const most = bridgeLands(spare, chain);
    const covers = most < left ? most : left;
    const sent = sendFor(covers, chain);
    bridges.push({ from: chain, usd: centsToUsd(sent < spare ? sent : spare) });
    left -= covers;
    if (left === 0n) break;
  }
  return bridges.length > 0 ? bridges : null;
}

interface Bridge {
  readonly from: FundingChain;
  /** What it sends, e.g. "2.00". */
  readonly usd: string;
}

/**
 * Where a card would spend more cash than is there once its own moves have
 * landed theirs, said for the agent, by the same rules a specialist's card is
 * checked by: a card that can't go through only wastes the tap. Null when
 * it's covered, or when the wallets couldn't be read.
 */
export async function unpaid(legs: readonly CashLeg[]): Promise<string | null> {
  if (!legs.some((leg) => leg.draws || leg.feeCash)) return null;
  const account = await uncoveredAccounts(legs);
  if (account)
    return `${placeName(account.place)} holds ${dollars(account.holdsUsd)} free, ${dollars(account.shortUsd)} short of what this spends there`;
  const cash = await walletCash();
  return cash && shortfallSaid(legs, cash.spendable);
}

/**
 * What the owner must add before a proposal's waiting legs can run:
 * each leg's USDC spend by chain against the live wallet USDC there, plus
 * what the proposal's own money moves bring to it first. Legs paid from
 * elsewhere (a venue account, a token) don't count.
 */
export async function proposalFunding(legs: readonly ActionRow[]): Promise<Funding | null> {
  const waiting = legs.filter((leg) => leg.status === "awaiting_permission").map(stagedLeg);
  if (!waiting.some((leg) => leg.draws || leg.feeCash)) return null;
  const cash = await walletCash();
  return cash && largestShortfall(waiting, cash.spendable);
}

/**
 * Each chain's cash, in cents: what a leg drawing there can spend (spendable)
 * and what a bridge can send from it (sendable: the wallet's own USDC, without
 * a prediction market's collateral). Chains that couldn't be read are left out. Null
 * when the portfolio couldn't be read at all.
 */
export async function walletCash(): Promise<{
  readonly spendable: Map<FundingChain, bigint>;
  readonly sendable: Map<FundingChain, bigint>;
} | null> {
  let portfolio;
  try {
    portfolio = await readPortfolioShared();
  } catch (error) {
    console.warn("wallet cash unreadable", error);
    return null;
  }
  const readable = CASH_KEYS.filter((chain) => !portfolio.unavailable.includes(chain));
  const spendable = new Map<FundingChain, bigint>(readable.map((chain) => [chain, 0n]));
  const sendable = new Map(spendable);
  for (const holding of portfolio.holdings) {
    const chain = holding.chain as FundingChain;
    if (!spendsAsChainCash(holding) || !spendable.has(chain)) continue;
    // The USDC itself, rounded down to the cent: a bridge sized from it must not send more
    // than the wallet holds.
    const cents = usdToCents(holding.quantity, "down");
    spendable.set(chain, (spendable.get(chain) ?? 0n) + cents);
    if (holding.venue === "wallet") sendable.set(chain, (sendable.get(chain) ?? 0n) + cents);
  }
  return { spendable, sendable };
}

/**
 * Cash a leg drawing on its chain can spend: the wallet's USDC, and an account's
 * dollar tokens on the chain they count as cash on (a prediction market's
 * collateral, see AccountCash), which a buy there spends before any of the wallet's.
 */
export function spendsAsChainCash(holding: Pick<Holding, "venue" | "chain" | "cash">): boolean {
  if (!holding.cash) return false;
  return (
    holding.venue === "wallet" ||
    chainCash().some(
      ({ about, cash }) => about.id === holding.venue && cash.chain === holding.chain,
    )
  );
}

/**
 * The USDC free in one place, in cents: the owner's own wallet on a chain (with
 * what an account's buy can spend there besides it, see AccountCash), or an
 * account kept in a ledger of its app's own.
 */
export async function cashCents(place: CashPlace): Promise<bigint> {
  const { evm, solana } = await walletAddresses();
  const ledger = ledgerAt(place);
  if (ledger) {
    const { cash } = ledger.account;
    return evm && cash?.kind === "ledger" ? await cash.free(evm as Address) : 0n;
  }
  const chain = place as FundingChain;
  const units =
    chain === "solana"
      ? solana
        ? await solanaTokenBalance(address(solana), SOLANA_USDC.mint, SOLANA_USDC.tokenProgram)
        : 0n
      : evm
        ? await evmBalance(chain, NETWORKS[chain].usdc, getAddress(evm))
        : 0n;
  let cents = units / 10_000n;
  for (const { cash } of chainCash())
    if (evm && cash.chain === chain) cents += await cash.free(getAddress(evm));
  return cents;
}
