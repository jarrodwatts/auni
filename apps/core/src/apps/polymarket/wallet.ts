import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  maxUint256,
  pad,
  parseAbi,
  type Address,
  type Hex,
} from "viem";

import { publicClient } from "../../money/chains.ts";
import type { SentTx, Signer } from "../../money/recipe.ts";
import { sendEvmSwap, type EvmQuoteRequest } from "../../money/swaps/evm.ts";
import { quoteSwap } from "../../money/swaps/routes.ts";
import { CONTRACTS } from "./http.ts";
import { microsText } from "./orders.ts";

export interface Call {
  readonly target: Address;
  readonly data: Hex;
  readonly value?: bigint;
}

const factoryAbi = parseAbi([
  "function predictWalletAddress(bytes32 salt) view returns (address)",
  "function predictLegacyWalletAddress(bytes32 salt) view returns (address)",
]);
// The conditional tokens and the PositionManager are both ERC-1155s: shares are read and
// approved the same way on either.
const sharesAbi = parseAbi([
  "function isApprovedForAll(address account, address operator) view returns (bool)",
  "function setApprovalForAll(address operator, bool approved)",
  "function balanceOf(address account, uint256 id) view returns (uint256)",
]);
const onrampAbi = parseAbi([
  "function paused(address asset) view returns (bool)",
  "function wrap(address asset, address to, uint256 amount)",
]);

// The factory predicts a legacy wallet for everyone, so one counts only where its code exists.
export async function depositWallet(
  owner: string,
): Promise<{ readonly address: Address; readonly deployed: boolean }> {
  const client = publicClient("polygon");
  const salt = pad(getAddress(owner).toLowerCase() as Hex, { size: 32 });
  const [current, legacy] = await Promise.all(
    (["predictWalletAddress", "predictLegacyWalletAddress"] as const).map((functionName) =>
      client.readContract({
        address: CONTRACTS.walletFactory,
        abi: factoryAbi,
        functionName,
        args: [salt],
      }),
    ),
  );
  if (!current || !legacy) throw new Error("The Polymarket wallet factory did not answer.");
  const [currentCode, legacyCode] = await Promise.all([
    client.getCode({ address: current }),
    client.getCode({ address: legacy }),
  ]);
  if (currentCode && currentCode !== "0x") return { address: current, deployed: true };
  if (legacyCode && legacyCode !== "0x") return { address: legacy, deployed: true };
  return { address: current, deployed: false };
}

export function erc20Balance(token: Address, holder: Address): Promise<bigint> {
  return publicClient("polygon").readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  });
}

function erc20Allowance(token: Address, holder: Address, spender: Address): Promise<bigint> {
  return publicClient("polygon").readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [holder, spender],
  });
}

/**
 * Shares of an outcome the owner's deposit wallet holds in `shares`, the market's share
 * contract; none before the wallet is deployed, or while there is none (null).
 */
export function heldShares(
  wallet: { readonly address: Address; readonly deployed: boolean } | null,
  shares: Address,
  tokenId: bigint,
): Promise<bigint> {
  return wallet?.deployed
    ? publicClient("polygon").readContract({
        address: shares,
        abi: sharesAbi,
        functionName: "balanceOf",
        args: [wallet.address, tokenId],
      })
    : Promise.resolve(0n);
}

/** Lets `operator` move the wallet's shares in `shares`, unless it already may. */
export async function shareApprovalCalls(
  wallet: Address | null,
  shares: Address,
  operator: Address,
): Promise<Call[]> {
  const approved =
    wallet &&
    (await publicClient("polygon").readContract({
      address: shares,
      abi: sharesAbi,
      functionName: "isApprovedForAll",
      args: [wallet, operator],
    }));
  return approved
    ? []
    : [
        {
          target: shares,
          data: encodeFunctionData({
            abi: sharesAbi,
            functionName: "setApprovalForAll",
            args: [operator, true],
          }),
        },
      ];
}

/**
 * Lets Polymarket's AutoRedeemer pay out the wallet's shares, on both share contracts, once
 * their market resolves, unless it already may: Polymarket's own trading setup grants the
 * same. Its source lets it only redeem a resolved position, paying the wallet that held it;
 * payouts.ts records what it paid.
 */
export async function autoRedeemCalls(wallet: Address | null): Promise<Call[]> {
  const calls = await Promise.all(
    [CONTRACTS.conditionalTokens, CONTRACTS.positionManager].map((shares) =>
      shareApprovalCalls(wallet, shares, CONTRACTS.autoRedeemer),
    ),
  );
  return calls.flat();
}

// The relayer relays no other exchange allowance: it must be exactly MaxUint256.
export async function pusdApprovalCalls(
  wallet: Address | null,
  spenders: readonly Address[],
  needed: bigint,
): Promise<Call[]> {
  const calls: Call[] = [];
  for (const spender of spenders) {
    if (wallet && (await erc20Allowance(CONTRACTS.pusd, wallet, spender)) >= needed) continue;
    calls.push({
      target: CONTRACTS.pusd,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [spender, maxUint256],
      }),
    });
  }
  return calls;
}

export interface Funding {
  readonly calls: readonly Call[];
  readonly pull?: { readonly asset: Address; readonly amount: bigint };
  /**
   * USDC.e the owner's native USDC must be swapped into before anything
   * else, while the onramp takes USDC.e but not native USDC. Set alone.
   */
  readonly convert?: bigint;
}

/** An asset the onramp can wrap into pUSD, as the deposit wallet and its owner hold it. */
export interface Wrappable {
  readonly asset: Address;
  readonly paused: boolean;
  readonly inWallet: bigint;
  readonly inOwner: bigint;
}

/**
 * The wallet's pUSD and, when it falls short of `required`, what it and its
 * owner hold of each asset the onramp wraps. The onramp pauses assets one by
 * one, so each is checked before it is wrapped.
 */
async function collateral(
  owner: Address,
  wallet: Address,
  required: bigint,
): Promise<{ readonly held: bigint; readonly assets: readonly Wrappable[] }> {
  const held = await erc20Balance(CONTRACTS.pusd, wallet);
  if (held >= required) return { held, assets: [] };
  return { held, assets: await wrappables(owner, wallet) };
}

function wrappables(owner: Address, wallet: Address): Promise<Wrappable[]> {
  const client = publicClient("polygon");
  return Promise.all(
    [CONTRACTS.usdce, CONTRACTS.usdc].map(async (asset): Promise<Wrappable> => {
      const [paused, inWallet, inOwner] = await Promise.all([
        client.readContract({
          address: CONTRACTS.collateralOnramp,
          abi: onrampAbi,
          functionName: "paused",
          args: [asset],
        }),
        erc20Balance(asset, wallet),
        erc20Balance(asset, owner),
      ]);
      return { asset, paused, inWallet, inOwner };
    }),
  );
}

/**
 * How the wallet comes to hold `required` pUSD: wrap the first asset the
 * onramp takes that covers what's missing, pulling from the owner what the
 * wallet lacks. Auni's cash on Polygon is native USDC, so while the onramp
 * takes only USDC.e, the owner's native USDC is swapped into it first.
 */
export function planFunding(
  wallet: Address,
  required: bigint,
  held: bigint,
  assets: readonly Wrappable[],
): Funding {
  if (held >= required) return { calls: [] };
  const shortfall = required - held;
  for (const { asset, paused, inWallet, inOwner } of assets) {
    if (paused || inWallet + inOwner < shortfall) continue;
    const calls = wrapCalls(asset, wallet, shortfall);
    return inWallet >= shortfall
      ? { calls }
      : { calls, pull: { asset, amount: shortfall - inWallet } };
  }
  const usdce = assets.find((entry) => entry.asset === CONTRACTS.usdce);
  const usdc = assets.find((entry) => entry.asset === CONTRACTS.usdc);
  if (usdce && usdc && !usdce.paused && usdc.paused) {
    const missing = shortfall - usdce.inWallet - usdce.inOwner;
    // The swap sells a little over what it must deliver, so that margin has to be there too.
    if (usdc.inOwner >= withMargin(missing)) return { calls: [], convert: missing };
  }
  const report = [
    `${microsText(held)} pUSD in the Polymarket wallet`,
    ...assets.map(
      ({ asset, paused, inWallet, inOwner }) =>
        `${microsText(inWallet + inOwner)} ${asset === CONTRACTS.usdce ? "USDC.e" : "native USDC"}${paused ? " (Polymarket is not accepting it right now)" : ""}`,
    ),
  ];
  const next = assets.every((entry) => entry.paused)
    ? "Polymarket is not accepting deposits right now; try again later."
    : "More USDC has to reach Polygon first.";
  throw new Error(
    `This order may draw ${microsText(required)} pUSD including fees. On Polygon there is ${report.join(", ")}. ${next}`,
  );
}

function wrapCalls(asset: Address, wallet: Address, amount: bigint): Call[] {
  return [
    {
      target: asset,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [CONTRACTS.collateralOnramp, amount],
      }),
    },
    {
      target: CONTRACTS.collateralOnramp,
      data: encodeFunctionData({
        abi: onrampAbi,
        functionName: "wrap",
        args: [asset, wallet, amount],
      }),
    },
  ];
}

// Native USDC and USDC.e trade 1:1, so the swap is held to 0.3% and sells
// 0.5% more than it must deliver: its floor still covers the order while
// USDC.e trades up to 0.2% under native USDC. 0.1% proved too tight to land
// every time. A few cents' swap costs its route more than 0.5% (5 cents was
// quoted 0.3% under in a real run), so the margin is at least a cent.
// Nothing is lost to the margin: what arrives past the order's need is
// wrapped into pUSD with it.
const CONVERT_SLIPPAGE_BPS = 30;
const CONVERT_MARGIN_BPS = 50n;
const CONVERT_MARGIN_FLOOR = 10_000n;

/** Native USDC to sell for `needed` USDC.e: a little over it, or all the owner has. */
export function conversionSale(needed: bigint, available: bigint): bigint {
  const padded = withMargin(needed);
  return padded < available ? padded : available;
}

/** `needed` plus the conversion's margin, rounded up, and never under a cent. */
function withMargin(needed: bigint): bigint {
  const margin = (needed * CONVERT_MARGIN_BPS + 9_999n) / 10_000n;
  return needed + (margin > CONVERT_MARGIN_FLOOR ? margin : CONVERT_MARGIN_FLOOR);
}

/**
 * Swaps the owner's native USDC for at least `needed` USDC.e, as a setup
 * step of the order.
 */
async function convertToUsdce(
  wallets: Signer,
  needed: bigint,
  available: bigint,
): Promise<{ readonly txs: readonly SentTx[]; readonly received: bigint }> {
  const request: EvmQuoteRequest = {
    chain: "polygon",
    sellToken: CONTRACTS.usdc,
    buyToken: CONTRACTS.usdce,
    sellAmount: conversionSale(needed, available),
    slippageBps: CONVERT_SLIPPAGE_BPS,
    taker: getAddress(wallets.evmAddress),
  };
  const route = await quoteSwap(request).catch((error: unknown) => {
    throw new Error(
      "Polymarket only takes USDC.e right now, and no swap from native USDC could be quoted on Polygon, so nothing moved. Try again shortly.",
      { cause: error },
    );
  });
  if (route.minBuyAmount < needed) {
    throw new Error(
      `Polymarket only takes USDC.e right now, and swapping ${microsText(request.sellAmount)} native USDC would guarantee only ${microsText(route.minBuyAmount)} USDC.e of the ${microsText(needed)} this order needs, so nothing moved.`,
    );
  }
  return sendEvmSwap(wallets, request, route, { setup: true });
}

/**
 * What the buy's setup batch does for the wallet to hold `required` pUSD,
 * and the swap sent first when native USDC had to become USDC.e.
 */
export async function fundBuy(
  wallets: Signer,
  wallet: Address,
  required: bigint,
): Promise<{ readonly funding: Funding; readonly txs: readonly SentTx[] }> {
  const owner = getAddress(wallets.evmAddress);
  const { held, assets } = await collateral(owner, wallet, required);
  const planned = planFunding(wallet, required, held, assets);
  if (planned.convert === undefined) return { funding: planned, txs: [] };
  const native = assets.find((entry) => entry.asset === CONTRACTS.usdc)?.inOwner ?? 0n;
  const { txs, received } = await convertToUsdce(wallets, planned.convert, native);
  // The swap's own receipt says what arrived, so a balance read from a node a
  // block behind can't miss it. What arrived past the order's need is wrapped
  // too, rather than left as USDC.e in the owner's wallet, where nothing
  // counts it as cash.
  const surplus = received > planned.convert ? received - planned.convert : 0n;
  const swapped = assets.map((entry) =>
    entry.asset === CONTRACTS.usdce ? { ...entry, inOwner: entry.inOwner + received } : entry,
  );
  const funding = planFunding(wallet, required + surplus, held, swapped);
  if (funding.convert !== undefined) {
    throw new Error(
      "The swap to USDC.e landed, but Polymarket still can't be funded from it; the USDC.e is in your wallet on Polygon.",
    );
  }
  return { funding, txs };
}

/**
 * What a buy can spend on Polygon besides the owner's native USDC, which
 * the caller counts as wallet cash: the deposit wallet's pUSD, and USDC.e
 * or native USDC the onramp takes right now, in the deposit wallet or, for
 * USDC.e, still in the owner's (a conversion whose batch then failed).
 */
export async function polymarketCash(owner: Address): Promise<bigint> {
  const { address: wallet } = await depositWallet(owner);
  const [held, assets] = await Promise.all([
    erc20Balance(CONTRACTS.pusd, wallet),
    wrappables(owner, wallet),
  ]);
  return spendableCollateral(held, assets);
}

export function spendableCollateral(held: bigint, assets: readonly Wrappable[]): bigint {
  return assets.reduce(
    (sum, { asset, paused, inWallet, inOwner }) =>
      paused ? sum : sum + inWallet + (asset === CONTRACTS.usdce ? inOwner : 0n),
    held,
  );
}
