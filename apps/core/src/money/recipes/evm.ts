import {
  formatEther,
  getAddress,
  isAddress,
  isAddressEqual,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { z } from "zod";

import { appLogo } from "../app-logo.ts";
import { approvedEffect, approvedMoved, assertStillAsShown } from "../approved.ts";
import { chainIdOf, chainKey, evmChainById, evmClient, isUsdcAt, RESERVES } from "../chains.ts";
import { costsLabel, staysYours, type Cost, type Effect } from "../effect.ts";
import { EVM_NATIVE, evmTokenKey } from "../fill-key.ts";
import { appFace, tradeFace, withFace, type TradeTerms } from "../card-face.ts";
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
  type AppHint,
  subjectDetails,
  tradeSide,
} from "../raw-transaction.ts";
import type { ActionPreview, Fill, Recipe } from "../recipe.ts";
import { formatUnits } from "../usd.ts";
import {
  amounts,
  simulateEffect,
  tokenNames,
  walletEffect,
  type Leg,
  type Moved,
  type SimulatedEffect,
  type TokenLeg,
  type TokenName,
  type WalletEffect,
  WouldFail,
} from "../wallet-effect.ts";
import { ownGas } from "../gas.ts";
import { coinMovedBy, confirmedReceipts } from "../swaps/evm.ts";
import { evmAddress, paysOwnGas } from "../wallets.ts";
import { feedListing } from "../token-feeds.ts";
import { appFor, appNamed, vouched } from "../readers.ts";
import type { BuiltCall } from "../../apps/contract.ts";

const call = z.object({
  to: z.string().regex(/^0x[0-9a-fA-F]{40}$/u),
  data: z
    .string()
    .regex(/^0x([0-9a-fA-F]{2})*$/u)
    .optional()
    .describe("ABI-encoded calldata; omit for a plain transfer of the native coin."),
  value: z.string().regex(/^\d+$/u).optional().describe("Native coin to send, in wei."),
});

const input = {
  chain: z
    .string()
    .describe('monad, base, arbitrum, polygon, or any EVM chain id as a number (e.g. "10").'),
  calls: z.array(call).min(1).max(8).describe("Sent in order as one batch."),
  ...rawTransactionInput,
};

/** One call as the agent gave it, as an app's reader takes it. */
function builtCall({ to, data, value }: z.infer<typeof call>): BuiltCall {
  return { to: getAddress(to), data: (data ?? "0x") as Hex, value: BigInt(value ?? "0") };
}

/** What the batch calls last; a token by name, so an approval's card says whose contract it is. */
function calleeLabel(to: string, names: ReadonlyMap<Address, TokenName>): string {
  const token = isAddress(to) ? names.get(getAddress(to)) : undefined;
  return token ? `${token.symbol} contract (${shortAddress(to)})` : shortAddress(to);
}

/**
 * One asset traded for another, on a tap, draws the trade card: what goes,
 * what comes back (see tradeSide), and what that costs.
 */
function tradeTerms(
  effect: WalletEffect,
  names: ReadonlyMap<Address, TokenName>,
  chain: string,
  costs: readonly Cost[],
): TradeTerms | null {
  const [sold] = effect.out;
  const [got] = effect.in;
  const soldName = sold && names.get(sold.token);
  const name = got && names.get(got.token);
  const side = tradeSide(effect, names);
  if (!side || !sold || !name) return null;
  const sells = soldName !== undefined && side === "sell";
  return {
    side: sells ? "sell" : "buy",
    symbol: sells ? soldName.symbol : name.symbol,
    stock: null,
    chain,
    receive: sells
      ? amounts([got], names)
      : formatAmount(Number(formatUnits(got.amount, name.decimals))),
    selling: amounts([sold], names),
    atLeast: null,
    price: null,
    costs: costsLabel(costs),
  };
}

/**
 * What the batch bought and sold, read from its receipt (see fillsFor). Only
 * tokens a token feed prices are holdings, which leaves out NFTs. The chain's coin
 * leaves no log on a receipt, so its amounts are the simulation's that execute ran
 * just before it sent, or, read back later, what the transaction's call trace moved.
 */
async function fillsOf(
  chainId: number,
  owner: Address,
  logs: readonly Log[],
  simulated: Moved | null,
): Promise<Fill[]> {
  const mined = walletEffect(logs, owner);
  const coin = (legs: readonly TokenLeg[] = []) =>
    legs.filter(({ token }) => token === EVM_NATIVE) as Leg[];
  const out = [...mined.out, ...coin(simulated?.out)];
  const into = [...mined.in, ...coin(simulated?.in)];
  const names = await tokenNames(chainId, { out, in: into, grants: [] });
  const cash = (token: string) => isUsdcAt(chainId, token);
  return fillsFor({ out, in: into }, names, cash, (token) => evmTokenKey(chainKey(chainId), token));
}

/**
 * Refuses a batch that would take the wallet's coin below what its chain keeps
 * there as a reserve, which would only revert once sent.
 */
async function assertKeepsReserve(
  chainId: number,
  owner: Address,
  effect: WalletEffect | null,
): Promise<void> {
  const chain = evmChainById(chainId);
  const reserve = chain && RESERVES[chain.key];
  const coinOut = (effect?.out ?? [])
    .filter(({ token }) => token === EVM_NATIVE)
    .reduce((sum, leg) => sum + leg.amount, 0n);
  if (!chain || !reserve || coinOut === 0n) return;
  const held = await evmClient(chainId).getBalance({ address: owner });
  if (held - coinOut >= reserve) return;
  const coin = chain.viem.nativeCurrency.symbol;
  throw new Error(
    `${chain.name} keeps ${formatEther(reserve)} ${coin} in the wallet as a reserve, and ` +
      `this batch sends ${formatEther(coinOut)} of its ${formatEther(held)} ${coin}, which would ` +
      `dip into it. Send less, then propose it again.`,
  );
}

/**
 * A batch's effect (see rawEffect), and what that alone can't say: a call that
 * did something Auni can't read is blind. The wallet sends the batch as one
 * transaction, so it is judged as one. Nothing in a batch delegates the
 * wallet: the only EIP-7702 authorization a wallet signs is to its own batch
 * executor, and describe refuses a call to the wallet's own account code.
 */
export function evmRawEffect(
  simulated: SimulatedEffect | null,
  names: ReadonlyMap<string, TokenName>,
): Effect {
  const effect = rawEffect(simulated, names);
  const blind = effect.blind ?? (simulated?.blind ? "does something Auni can't see" : null);
  return blind ? { ...effect, blind } : effect;
}

export const sendEvmTransaction: Recipe<typeof input> = {
  tool: "send_evm_transaction",
  venue: "evm",
  description:
    "Send one or more calls from the owner's EVM wallet on any EVM chain, as one batch. Use it " +
    "for anything no other money tool covers: a swap where Auni has no tool, a claim, a vote. " +
    "Put an approval in the same batch as the call that spends it, approving exactly what it " +
    "spends. Auni simulates the batch and shows the owner what leaves and arrives, and it goes " +
    "on a tap when what it gets lands in their wallet, priced, worth at least half of what it " +
    "sends. Its card also checks it's the owner allowing it when it sends assets with nothing back to a " +
    "contract or anyone they've never sent to, moves a token Auni can't price, gets back under " +
    "half, leaves a permission behind, has a call Auni can't see do anything, or can't be " +
    "simulated. " +
    "A card that sends money where nobody can ever spend it (a burn address, a token's own " +
    "contract) says on it that it is gone for good. " +
    "A call to the wallet's own address is refused. A batch that reverts in the simulation " +
    "comes back as an error: build it again rather than editing its data.",
  input,
  // Its dollars are what it sends, whatever that is, so it says what it buys without a buy's dollars.
  about: ({ input, details }) => rawSubject(details, chainKey(chainIdOf(input.chain))),
  async describe({ chain, calls, summary: said, app }) {
    const id = chainIdOf(chain);
    // A chain Auni can't read is refused here: its receipt could never be checked.
    const name = evmChainById(id)?.name ?? evmClient(id).chain?.name ?? `Chain ${id}`;
    const wallet = await evmAddress();
    if (!wallet)
      throw new Error(
        "Its effect is read by simulating it from the wallet, and the wallet holds no key there yet: build it with a recipe tool instead.",
      );
    const owner = getAddress(wallet);
    // Under EIP-7702 the wallet's own address runs the account code that guards it.
    if (calls.some(({ to }) => isAddressEqual(to as Address, owner)))
      throw new Error("Auni won't send this: it calls your wallet's own account code.");
    const hintedSite = app ? siteHost(app.site) : null;
    const built = calls.map(builtCall);
    const [simulated, gas, known, hintedLogo] = await Promise.all([
      simulateEffect(id, owner, calls).catch((error: unknown) => {
        // The agent built this batch call by call, so it hears which one failed.
        if (!(error instanceof WouldFail) || error.of === 1) throw error;
        throw new Error(`${error.message} The call that failed is ${error.step} of ${error.of}.`, {
          cause: error.cause,
        });
      }),
      paysOwnGas(id).then((own) => (own ? ownGas(id, owner, calls) : null)),
      appFor(chainKey(id), owner, built),
      hintedSite ? appLogo(hintedSite) : null,
    ]);
    // An app whose own contracts the whole batch calls names it, in place of the agent's hint.
    const vouch = known && vouched(known, built, simulated);
    // Else the agent's name stands, and if it is one of Auni's apps the card says that app doesn't know this.
    const named = app && !vouch ? appNamed(app.name, hintedSite) : null;
    const hint: AppHint | undefined = vouch
      ? {
          name: vouch.name,
          vouched: true,
          verb: vouch.reading?.verb ?? "",
          ...(vouch.reading?.title ? { title: vouch.reading.title } : {}),
          ...(vouch.reading?.toChain ? { to_chain: vouch.reading.toChain } : {}),
          ...(vouch.reading?.finePrint ? { finePrint: vouch.reading.finePrint } : {}),
        }
      : app && { ...app, ...(named ? { unknownTo: named } : {}) };
    const site = vouch ? null : hintedSite;
    const logo = vouch ? (vouch.logo ? { src: vouch.logo, inset: true } : null) : hintedLogo;
    const summary = vouch?.reading?.title ?? said;
    await assertKeepsReserve(id, owner, simulated);
    const names = await tokenNames(id, simulated);
    const coin = gas ? await feedListing(chainKey(id), EVM_NATIVE).catch(() => null) : null;
    const gasUsd = gas && coin?.usdPrice ? Number(formatEther(gas.fee)) * coin.usdPrice : 0;
    const raw = evmRawEffect(simulated, names);
    const effect: Effect = gasUsd
      ? { ...raw, costs: [...(raw.costs ?? []), { label: "network fee", usd: gasUsd }] }
      : raw;
    // A trade card only for a trade a tap can vouch for.
    const trade =
      simulated && staysYours(effect)
        ? tradeTerms(simulated, names, name, effect.costs ?? [])
        : null;
    // What a trade is about: what a sell lets go, or what a buy gets.
    const traded = trade
      ? (trade.side === "sell" ? simulated?.out : simulated?.in)?.[0]
      : undefined;
    // A figure on the app's card only once it reaches a cent, as on Solana (see solana.ts).
    const networkFee = gasUsd >= 0.01 ? usdLabel(gasUsd) : null;
    // The app's name may be the agent's word, so the card also shows the contract the batch ends
    // on, by the name the app that vouches for it gives it where one does.
    const last = calls.at(-1)!.to;
    const via = known ? `${known.callee} (${shortAddress(last)})` : calleeLabel(last, names);
    const terms =
      hint && simulated
        ? appTerms(hintFor(hint, effect), site, logo, simulated, names, name, networkFee, via)
        : null;
    const sells = rawSale(
      simulated,
      names,
      (token) => isUsdcAt(id, token),
      (token) => evmTokenKey(chainKey(id), token),
    );
    const made: ActionPreview = {
      summary,
      amountUsd: leavesUsd(simulated, names),
      effect,
      details: {
        // The chain, which the card names when no token or app does (see raw-transaction.ts).
        network: name,
        ...(simulated ? approvedEffect(simulated) : {}),
        // So its card wears the logo of the token it trades, or else the app's.
        ...subjectDetails(chainKey(id), traded, names, hint, logo),
      },
      ...(sells ? { sells } : {}),
      // Core checks the wallet can pay their fee, and buys the chain's coin first where it can't.
      sends: { chainId: id, calls },
    };
    // The app's card where the agent named one, a trade's where the simulation shows one, and
    // otherwise the plain face core makes of any move.
    if (terms) return withFace(made, (said) => appFace(terms, said));
    return trade ? withFace(made, (said) => tradeFace(trade, said)) : made;
  },
  async execute({ action, input: { chain, calls }, wallets }) {
    const id = chainIdOf(chain);
    const owner = getAddress(wallets.evmAddress);
    const simulated = await simulateEffect(id, owner, calls);
    // A tap, with the owner's proof or without, vouched for what the card showed; the chain may
    // have moved since.
    const fresh = evmRawEffect(simulated, await tokenNames(id, simulated));
    assertStillAsShown(action, fresh, simulated);
    // Another move may have spent the wallet's coin since the card was drawn.
    await assertKeepsReserve(id, owner, simulated);
    const hash = await wallets.sendEvmTransaction(id, calls);
    const { logs } = await evmClient(id).waitForTransactionReceipt({
      hash: hash as Hex,
      timeout: 90_000,
    });
    return {
      txs: [{ chain: chainKey(id), hash }],
      fills: await fillsOf(id, owner, logs, simulated),
    };
  },
  // The batch is one transaction: its receipt says all it moved but the chain's coin, which its
  // call trace says. A card that showed none of the coin moving needs no trace.
  async readBack({ action, input: { chain }, evmAddress }) {
    const id = chainIdOf(chain);
    const receipts = evmAddress ? await confirmedReceipts(chainKey(id), action.txs) : [];
    if (!evmAddress || receipts.length === 0) return null;
    const owner = getAddress(evmAddress);
    const coin = await coinMovedBy(chainKey(id), receipts, owner);
    const shown = approvedMoved(action);
    const showedCoin = [...(shown?.out ?? []), ...(shown?.in ?? [])].some(
      ({ token }) => token === EVM_NATIVE,
    );
    if (!coin && showedCoin) return null;
    const legs = (amount: bigint) => (amount > 0n ? [{ token: EVM_NATIVE, amount }] : []);
    const moved = { out: legs(coin?.out ?? 0n), in: legs(coin?.in ?? 0n) };
    const logs = receipts.flatMap((receipt) => receipt.logs);
    return { fills: await fillsOf(id, owner, logs, moved) };
  },
};
