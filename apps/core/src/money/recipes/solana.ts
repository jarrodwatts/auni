import { NETWORKS } from "@auni/shared";
import { address } from "@solana/kit";
import { z } from "zod";

import { appLogo } from "../app-logo.ts";
import { approvedEffect, assertStillAsShown, type Approved } from "../approved.ts";
import { staysYours, type Effect } from "../effect.ts";
import { solanaMintKey, WRAPPED_SOL } from "../fill-key.ts";
import { appFace, withFace } from "../card-face.ts";
import { formatAmount, shortAddress, usdLabel } from "../format.ts";
import {
  appTerms,
  fillsFor,
  hintFor,
  leavesUsd,
  rawEffect,
  rawSubject,
  rawSale,
  rawTransactionInput,
  siteHost,
  subjectDetails,
  tradeSide,
} from "../raw-transaction.ts";
import { appNamed } from "../readers.ts";
import type { ActionPreview, Fill, Recipe, SentTx } from "../recipe.ts";
import { landedEffect, simulateSolana, type SolanaSimulation } from "../solana-effect.ts";
import { formatUnits } from "../usd.ts";
import type { TokenName } from "../wallet-effect.ts";
import { noAddressOn, solanaAddress } from "../wallets.ts";
import { solUsd } from "../token-feeds.ts";
import { solForFees, topUpSol, withTopUp, type SolTopUp } from "../sol-top-up.ts";
import { solanaPrice, solanaTokens } from "../swaps/solana-swap.ts";

/**
 * The most network fee a tap lets an app set for the wallet to pay, 0.01 SOL:
 * the cap a Solana route's docs show for its highest priority.
 */
const TAP_FEE_LAMPORTS = 10_000_000n;

const input = {
  transaction: z
    .string()
    .regex(/^[A-Za-z0-9+/]+={0,2}$/u)
    .max(1644)
    .describe(
      "One base64 transaction (legacy or v0) built for the owner's Solana wallet, as an app's API " +
        "returns it. No one but the owner signs it. Any blockhash will do: Auni puts a fresh one on it.",
    ),
  ...rawTransactionInput,
};

/**
 * Symbol, decimals and price of each mint, from the Solana route, which prices many
 * thin tokens whose price can be pushed up, so only a token it verifies is
 * priced. One it doesn't list is named by its address, with the chain's decimals.
 */
async function tokenNames(
  mints: readonly string[],
  decimals: ReadonlyMap<string, number>,
): Promise<Map<string, TokenName>> {
  const unique = [...new Set(mints)];
  const listed = unique.length ? await solanaTokens(unique).catch(() => []) : [];
  return new Map(
    await Promise.all(
      unique.map(async (mint): Promise<[string, TokenName]> => {
        const token = listed.find((each) => each.mint === mint);
        // In the raw units the chain counts, as solana_swap prices it.
        const price = token?.verified ? await solanaPrice(mint).catch(() => null) : null;
        return [
          mint,
          {
            symbol: token?.symbol ?? shortAddress(mint),
            decimals: decimals.get(mint) ?? token?.decimals ?? 0,
            ...(token ? { name: token.name } : {}),
            ...(price ? { usd: price.usdPrice * price.multiplier } : {}),
          },
        ];
      }),
    ),
  );
}

const namesOf = ({ effect, decimals }: SolanaSimulation) =>
  tokenNames(
    [...effect.out, ...effect.in, ...effect.grants].map(({ token }) => token),
    decimals,
  );

/**
 * A transaction's effect (see rawEffect), and what a tap can't vouch for,
 * which takes the owner's proof: a change to what an app keeps for the wallet, whose
 * hands Auni can't read; moving nothing Auni can see at all; and a network fee
 * past what a tap allows, since the app sets it and the wallet pays it. Where
 * money leaving the wallet goes Solana doesn't say, so it always takes the
 * code. A program can't own the wallet itself: simulateSolana refuses that.
 */
function solanaRawEffect(
  simulation: SolanaSimulation,
  names: ReadonlyMap<string, TokenName>,
): Effect {
  const { effect, position, fee } = simulation;
  const blind = position
    ? `changes what your wallet keeps at ${shortAddress(position)}, which Auni can't read`
    : !effect.out.length && !effect.in.length && !effect.grants.length
      ? "moves nothing Auni can see"
      : fee > TAP_FEE_LAMPORTS
        ? `pays ${formatAmount(Number(formatUnits(fee, 9)))} SOL in network fees, more than a tap allows`
        : null;
  const raw = rawEffect(effect, names);
  return blind ? { ...raw, blind } : raw;
}

/**
 * How the wallet buys the SOL it is short (see sol-top-up.ts), or null when it
 * holds enough. It buys only the network's due: SOL the transaction itself
 * sends is the wallet's to hold first. On a card's run, it spends what the card
 * showed (`approved`).
 */
async function topUpFor(
  { effect, short }: SolanaSimulation,
  approved?: Approved,
): Promise<SolTopUp | null> {
  if (!short) return null;
  const sol = effect.out.find(({ token }) => token === WRAPPED_SOL);
  if (sol)
    throw new Error(
      `It sends ${formatAmount(Number(formatUnits(sol.amount, 9)))} SOL, more than the wallet holds. Buy SOL with solana_swap first, then propose it again.`,
    );
  const spends = effect.out.find(({ token }) => token === NETWORKS.solana.usdc)?.amount ?? 0n;
  return solForFees(short, { spends, approved });
}

/**
 * The network fee and rent in dollars, their SOL at its price: what the transaction spends, never
 * the SOL bought for them, most of which stays. The app's card shows it only once it reaches a
 * cent.
 */
async function networkFeeUsd(lamports: bigint): Promise<number> {
  return Number(formatUnits(lamports, 9)) * (await solUsd());
}

export const sendSolanaTransaction: Recipe<typeof input> = {
  tool: "send_solana_transaction",
  venue: "solana",
  // A wallet with no Solana key can send nothing there, so it isn't offered this.
  description: ({ solana }) =>
    !solana
      ? null
      : "Send one transaction from the owner's Solana wallet, as a Solana app's API builds it for " +
        "that wallet. Use it only for what Solana alone has and no other money tool covers; " +
        "anything Monad can do is done on Monad. Auni simulates it and shows the owner what leaves " +
        "and arrives, and it goes on a tap when what it gets lands in their wallet, priced, worth " +
        "at least half of what it sends. Its card also checks it's the owner allowing it when it sends assets " +
        "away with nothing back, moves a token Solana's token listing doesn't verify, gets back under half, " +
        "leaves a permission behind, changes an account an app keeps for the wallet (a position, " +
        "a stake account, compressed NFTs), moves nothing Auni can see, or sets a network fee " +
        "over 0.01 SOL. The wallet pays its own network fee and rent in SOL; when it holds too " +
        "little, a little of its USDC buys that first (on Solana, or on Monad for a wallet with no " +
        "sponsor), shown as SOL for fees, which stays in the wallet but for what the fee takes. A transaction that fails in the " +
        "simulation comes back as an error: build it again rather than editing it.",
  input,
  // Its dollars are what it sends, whatever that is, so it says what it buys without a buy's dollars.
  about: ({ details }) => rawSubject(details, "solana"),
  async describe({ transaction, summary, app }) {
    const wallet = await solanaAddress();
    if (!wallet) throw new Error(noAddressOn("Solana"));
    const owner = address(wallet);
    const site = app ? siteHost(app.site) : null;
    // No app of Auni's vouches for a Solana transaction the agent built: if the agent's name is
    // one of Auni's apps, the card says that app doesn't know this.
    const named = app ? appNamed(app.name, site) : null;
    const hint = app && { ...app, ...(named ? { unknownTo: named } : {}) };
    const [simulation, logo] = await Promise.all([
      simulateSolana(transaction, owner, { paysOwnFee: true }),
      site ? appLogo(site) : null,
    ]);
    const { effect: seen, via } = simulation;
    const [names, topUp] = await Promise.all([namesOf(simulation), topUpFor(simulation)]);
    const feeUsd = await networkFeeUsd(simulation.fee + simulation.rent);
    const raw = solanaRawEffect(simulation, names);
    // What it spends of SOL is its network fee, said here unless the card buys the SOL for it:
    // that purchase covers it and is said in its place (withTopUp), as on an EVM chain.
    const effect: Effect = topUp
      ? raw
      : { ...raw, costs: [...(raw.costs ?? []), { label: "network fee", usd: feeUsd }] };
    // What a trade is about, for its logo: what it gets, or what it lets go for dollars.
    const side = staysYours(effect) ? tradeSide(seen, names) : null;
    const traded = side === "sell" ? seen.out[0] : side ? seen.in[0] : undefined;
    const sells = rawSale(seen, names, (token) => token === NETWORKS.solana.usdc, solanaMintKey);
    const networkFee = feeUsd >= 0.01 ? usdLabel(feeUsd) : null;
    const terms = hint
      ? appTerms(hintFor(hint, effect), site, logo, seen, names, "Solana", networkFee, {
          via: null,
          contract: via,
        })
      : null;
    const made: ActionPreview = {
      summary,
      amountUsd: leavesUsd(seen, names),
      effect,
      details: {
        // The chain, which the card names when no token or app does (see raw-transaction.ts).
        network: "Solana",
        ...approvedEffect(seen),
        // So its card wears the logo of the token it trades, or else the app's.
        ...subjectDetails("solana", traded, names, hint, logo),
      },
      ...(sells ? { sells } : {}),
    };
    return withTopUp(terms ? withFace(made, (said) => appFace(terms, said)) : made, topUp);
  },
  async execute({ action, input: { transaction }, wallets }) {
    const owner = address(wallets.solanaAddress);
    const first = await simulateSolana(transaction, owner, { paysOwnFee: true });
    const topUp = await topUpFor(first, action);
    const txs: SentTx[] = topUp ? await topUpSol(wallets, topUp) : [];
    // A wallet short of SOL was checked on a lent copy, which a program can tell from the one
    // that goes, so once its SOL is bought it is checked again just as it will be sent.
    const simulation = topUp
      ? await simulateSolana(transaction, owner, { paysOwnFee: true })
      : first;
    if (simulation.short)
      throw new Error(
        "The wallet is still short of SOL after buying some, so the transaction wasn't sent. Propose it again.",
      );
    // A tap, with the owner's proof or without, vouched for what the card showed, but the chain
    // may have moved since, and a short wallet's card showed the lent copy, which a program can
    // tell from this one.
    const fresh = solanaRawEffect(simulation, await namesOf(simulation));
    assertStillAsShown(action, fresh, simulation.effect);
    // Signed after any top-up has landed, on a blockhash its wait can't have outlived.
    const hash = await wallets.sendSolanaTransaction(await simulation.wire(), { paysOwnFee: true });
    txs.push({ chain: "solana", hash });
    return { txs, fills: await landedFills(hash, owner, simulation.decimals) };
  },
  // Its one transaction says all it moved. Only a token the route lists is priced, and so a
  // fill, and the listing gives its decimals where no simulation does.
  async readBack({ action, solanaAddress: owner }) {
    const hash = action.txs.findLast((tx) => tx.chain === "solana" && tx.hash && !tx.setup)?.hash;
    return owner && hash ? { fills: await landedFills(hash, owner, new Map()) } : null;
  },
};

/** What a landed transaction bought and sold for the wallet, read from the chain (see fillsFor). */
async function landedFills(
  hash: string,
  owner: string,
  decimals: ReadonlyMap<string, number>,
): Promise<Fill[]> {
  const landed = await landedEffect(hash, owner);
  const mints = [...landed.out, ...landed.in].map(({ token }) => token);
  const cash = (token: string) => token === NETWORKS.solana.usdc;
  return fillsFor(landed, await tokenNames(mints, decimals), cash, solanaMintKey);
}
