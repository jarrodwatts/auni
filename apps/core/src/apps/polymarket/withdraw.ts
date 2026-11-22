import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddressEqual,
  parseAbi,
  type Address,
} from "viem";
import { z } from "zod";

import { APPROVED_PROCEEDS, assertApprovedProceeds } from "../../money/approved.ts";
import { usdLabel } from "../../money/format.ts";
import type { Recipe } from "../../money/recipe.ts";
import { slippageFloor } from "../../money/swaps/evm.ts";
import { centsToUsd, usdToCents } from "../../money/usd.ts";
import { evmAddress } from "../../money/wallets.ts";
import { simulateEffect } from "../../money/wallet-effect.ts";
import { withdrawFace } from "./card.ts";
import { CONTRACTS, POLYGON } from "./http.ts";
import { microsText, toMicros } from "./orders.ts";
import { reverted } from "./problems.ts";
import { runBatch } from "./relayer.ts";
import { depositWallet, erc20Balance, type Call } from "./wallet.ts";

// Bringing Polymarket cash home: pUSD in the owner's deposit wallet becomes USDC in their own
// wallet on Polygon, in one batch Polymarket's relayer sends, so the owner needs none of
// Polygon's coin. Polymarket's offramp pays pUSD out one for one, but only as USDC.e, the
// bridged dollar that backs it (its vault holds no other, and the offramp has native USDC
// paused). Auni's cash on Polygon is native USDC, so the batch swaps the USDC.e in the pool
// Polymarket's own withdrawal uses, paying the owner's wallet. The wallet runs the four calls
// in order, all or none:
//
//   pUSD.approve(offramp, amount)             the offramp may take exactly this pUSD
//   offramp.unwrap(USDC.e, wallet, amount)    and pays the deposit wallet as much USDC.e
//   USDC.e.approve(router, amount)            the router may take exactly that USDC.e
//   router.exactInputSingle(... owner, least) and pays the owner USDC, at least the card's
//
// Each approval is spent whole by the call after it, so the batch leaves no permission behind.

/** Uniswap V3's SwapRouter on Polygon. Polymarket's relayer carries a swap to it (fixtures/cash-home-relayed.json). */
export const SWAP_ROUTER: Address = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
/** The fee tier, in hundredths of a basis point, of the USDC.e and USDC pool Polymarket's own withdrawal swaps in. */
const POOL_FEE = 100;

/**
 * How far under what the pool pays now a card's least sits, in basis points: Polymarket's own
 * withdrawal holds its swap to the same tenth of a percent. Both sides are dollars, so the pool's
 * price barely moves between a card and its tap.
 */
const SLACK_BPS = 10;
/** The most of a dollar a card may lose to the pool, in basis points: past it the pool has run short, and no card is offered. */
const MOST_LOST_BPS = 100;
/** A cent of pUSD or USDC, which both count in millionths of a dollar. */
const CENT = 10_000n;

const offrampAbi = parseAbi(["function unwrap(address asset, address to, uint256 amount)"]);
const routerAbi = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 deadline; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
]);

/**
 * The batch that brings `amount` of the deposit wallet's pUSD to `owner` as USDC, refusing to
 * unless at least `least` arrives. The owner is the only address money is paid to.
 */
export function homeCalls(wallet: Address, owner: Address, amount: bigint, least: bigint): Call[] {
  const approve = (token: Address, spender: Address): Call => ({
    target: token,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
  });
  return [
    approve(CONTRACTS.pusd, CONTRACTS.collateralOfframp),
    {
      target: CONTRACTS.collateralOfframp,
      data: encodeFunctionData({
        abi: offrampAbi,
        functionName: "unwrap",
        args: [CONTRACTS.usdce, wallet, amount],
      }),
    },
    approve(CONTRACTS.usdce, SWAP_ROUTER),
    {
      target: SWAP_ROUTER,
      data: encodeFunctionData({
        abi: routerAbi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: CONTRACTS.usdce,
            tokenOut: CONTRACTS.usdc,
            fee: POOL_FEE,
            recipient: owner,
            // The batch itself is good for ten minutes (see runBatch), and so is its swap.
            deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
            amountIn: amount,
            amountOutMinimum: least,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    },
  ];
}

/**
 * The batch for `amount`, run first on Polygon as the deposit wallet would run it, with nothing
 * signed, and the USDC it pays the owner's wallet. Throws what Polymarket's contracts or the
 * pool refuse it with, in the owner's words, and when no node could run it: nothing unchecked
 * is offered or signed.
 */
async function ranFirst(
  wallet: Address,
  owner: Address,
  amount: bigint,
  least: bigint,
): Promise<{ readonly calls: Call[]; readonly arrives: bigint }> {
  const calls = homeCalls(wallet, owner, amount, least);
  const effect = await simulateEffect(
    POLYGON,
    owner,
    calls.map(({ target, data }) => ({ to: target, data })),
    { from: wallet },
  ).catch((error: unknown) => {
    throw reverted(error);
  });
  if (!effect)
    throw new Error(
      "Auni couldn't check this on Polygon just now, so nothing was sent. Try again in a moment.",
    );
  const usdc = effect.in.find(({ token }) => isAddressEqual(token, CONTRACTS.usdc));
  return { calls, arrives: usdc?.amount ?? 0n };
}

/** The owner's Polymarket wallet and the pUSD in it: its cash, all of it free to bring back. */
async function cashThere(
  owner: string | null,
): Promise<{ readonly owner: Address; readonly wallet: Address; readonly cash: bigint }> {
  const wallet = owner ? await depositWallet(owner) : null;
  if (!owner || !wallet?.deployed)
    throw new Error("There is no Polymarket wallet of yours yet, so no cash there to bring back.");
  return {
    owner: getAddress(owner),
    wallet: wallet.address,
    cash: await erc20Balance(CONTRACTS.pusd, wallet.address),
  };
}

const usd = (micros: bigint) => usdLabel(Number(microsText(micros)));
/** Dollars to the cent, rounded down: what a card says at least arrives. */
const usdDown = (micros: bigint) => usd(micros - (micros % CENT));

const input = {
  amountUsd: z
    .number()
    .positive()
    .optional()
    .describe("Dollars of Polymarket cash to bring back. Leave it out to bring all of it."),
};

export const polymarketWithdraw: Recipe<typeof input> = {
  tool: "polymarket_withdraw",
  description:
    "Bring cash from the owner's Polymarket wallet back to their own wallet on Polygon, where it arrives as USDC a moment later and counts as their Polygon cash. It always goes to their own wallet, never to another address. Only cash can come: the cash get_portfolio shows at Polymarket, which is what sales and payouts paid and what a buy has not spent. Shares in a bet are not cash until they are sold or their market pays out. Leave amountUsd out to bring all of it. Polymarket's dollars turn into USDC through a pool that keeps a hundredth of a percent, so the card shows about what leaves arriving, and the least it accepts. The owner needs none of Polygon's coin: Polymarket's relayer sends it. It runs after any other Polymarket move still going, and before the picks on its own card, so it can't bring what a sale on the same card will pay: sell first, and withdraw once that has settled.",
  input,
  venue: "polymarket",
  readies: () => "polygon",
  about: () => ({ kind: "cash", at: "polymarket" }),

  async describe({ amountUsd }) {
    const { owner, wallet, cash } = await cashThere(await evmAddress());
    const all = amountUsd === undefined;
    // In whole cents, as a card keeps its amount: all of it leaves a part of a cent behind.
    const cents = all ? cash / CENT : BigInt(Math.round(amountUsd * 100));
    const amount = cents * CENT;
    if (amount > cash)
      throw new Error(
        `Your Polymarket wallet holds ${usdDown(cash)} of cash, less than the ${usd(amount)} asked for. Shares in a bet are not cash until they are sold or paid out.`,
      );
    if (cents === 0n)
      throw new Error(
        all
          ? "Your Polymarket wallet holds no cash to bring back."
          : "That is under a cent, too little to bring back.",
      );
    const { arrives } = await ranFirst(wallet, owner, amount, 0n);
    if (arrives < slippageFloor(amount, MOST_LOST_BPS))
      throw new Error(
        `The pool that turns Polymarket's dollars into USDC is short right now: ${usd(amount)} would come back as ${usdDown(arrives)}. A smaller amount may go through, or the same one later.`,
      );
    const least = slippageFloor(arrives, SLACK_BPS);
    return {
      summary: all
        ? `Bring all your Polymarket cash (${usd(amount)}) back to your wallet on Polygon`
        : `Bring ${usd(amount)} of your Polymarket cash back to your wallet on Polygon`,
      amountUsd: centsToUsd(cents),
      // A batch Auni's code builds against Polymarket's offramp and one Uniswap pool, which
      // pays the owner's own wallet; it was run first, and what it paid there is `arrives`.
      effect: {
        gives: [{ text: `${usd(amount)} of Polymarket cash` }],
        gets: [{ text: `at least ${usdDown(least)} of USDC in your wallet on Polygon` }],
        grants: [],
        costs:
          arrives < amount
            ? [{ label: "to the pool", usd: Number(microsText(amount - arrives)) }]
            : [],
      },
      // The least the swap lets arrive, which execute sends as the swap's own floor.
      details: { [APPROVED_PROCEEDS]: microsText(least) },
      card: withdrawFace({ arrives: usd(arrives), least: usdDown(least), all }),
    };
  },

  async execute({ action, wallets, recordSent, posting }) {
    const floor = action.details[APPROVED_PROCEEDS];
    if (floor === undefined)
      throw new Error("This card doesn't say the least it brings back. Nothing was sent.");
    // Exactly the card's amount, whatever the wallet holds by now, and never more.
    const amount = usdToCents(action.amountUsd) * CENT;
    const { owner, wallet, cash } = await cashThere(wallets.evmAddress);
    if (amount > cash)
      throw new Error(
        `Your Polymarket wallet now holds ${usdDown(cash)} of cash, less than the ${usd(amount)} on this card, so nothing moved.`,
      );
    // Run first with the card's least as the swap's own floor: it goes only if that still arrives.
    const { calls, arrives } = await ranFirst(wallet, owner, amount, toMicros(floor));
    assertApprovedProceeds(action, arrives, 6);
    // Kept as maybe sent before the relayer is asked, so a run cut off once it may have taken
    // the batch is held, never failed; the relayer's id speaks for it once it answers.
    const hash = await posting("polygon", () =>
      runBatch(wallets, wallet, { calls, metadata: "auni cash home", setup: false }, recordSent),
    );
    return { txs: [{ chain: "polygon", hash }], fills: [] };
  },
};
