import { isEvmChain, NETWORK_KEYS, NETWORKS, WITHDRAW_NETWORKS } from "@auni/shared";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { encodeFunctionData, erc20Abi, type Address } from "viem";
import { z } from "zod";

import { firstBridge, filling } from "../../apps/registry.ts";
import { chainName, SOLANA_USDC, solanaKitRpc } from "../chains.ts";
import { withdrawalFace, type WithdrawalTerms } from "../card-face.ts";
import { shortAddress } from "../format.ts";
import type { Approved } from "../approved.ts";
import { NothingMoved, type Recipe, type SentTx, type Signer } from "../recipe.ts";
import { solFor, topUpSol, withTopUp } from "../sol-top-up.ts";
import { dollars } from "../summaries.ts";
import { centsToUsd, formatUnits, normalizeUsd, parseUnits } from "../usd.ts";
import { noAddressOn, walletAddresses } from "../wallets.ts";
import {
  destinationAddress,
  maxWithdrawal,
  refuseTokenDestination,
  walletUsdc,
  usdcToUsd,
  withdrawalSource,
  WITHDRAW_TOOL,
} from "../withdrawals.ts";
import { opensUsdcAccount, solToOpen, usdcAccountOf } from "../usdc-account.ts";

const input = {
  amount_usd: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/u)
    .describe('Dollars to withdraw, e.g. "50" or "12.5".'),
  network: z
    .enum(WITHDRAW_NETWORKS)
    .describe("The network the destination takes USDC on. Coinbase takes Base."),
  address: z.string().trim().min(1).max(100).describe("Exactly the address the owner gave you."),
  destination: z
    .enum(["exchange", "wallet"])
    .optional()
    .describe(
      "Only what the owner said the address is: exchange for an exchange account of theirs (like " +
        "Coinbase), wallet for a wallet they said is their own. Leave it out when they didn't say: " +
        "the card then names the address, never theirs.",
    ),
};

/**
 * Where a withdrawal goes, as its card says it: the owner's exchange or own wallet only when
 * they said so (`destination`), else the address itself, since Auni can't know whose it is.
 */
function destinationName(destination: "exchange" | "wallet" | undefined, to: string): string {
  if (destination === "exchange") return "your exchange";
  if (destination === "wallet") return "your wallet";
  return shortAddress(to);
}

export const withdrawUsdc: Recipe<typeof input> = {
  tool: WITHDRAW_TOOL,
  venue: "withdrawal",
  about: () => ({ kind: "cash", at: "wallet" }),
  description:
    "Withdraw the owner's cash (USDC) out of Auni to an address they gave, in dollars. " +
    "Only for an address the owner gave you, on the network they named. It always waits for the " +
    "owner's tap, whatever their rules; a first withdrawal to an address also checks it's " +
    "them. Paid from their wallet cash: sell holdings to cash first if it isn't enough. A burn " +
    "address, where nobody can ever spend what is sent, is refused; an owner who means to burn " +
    "money can send it with send_evm_transaction, whose card says it is gone for good.",
  input,
  async describe({ amount_usd, network, address: raw, destination }) {
    const amount = normalizeUsd(amount_usd);
    const units = parseUnits(amount, 6);
    if (units === 0n) throw new Error("Enter an amount to withdraw.");
    const own = await walletAddresses();
    const to = destinationAddress(network, raw, own);
    await refuseTokenDestination(network, to);

    const balances = await walletUsdc();
    const source = withdrawalSource(network, units, balances);
    if (!source) {
      const most = maxWithdrawal(network, balances);
      const total = [...balances.values()].reduce((sum, balance) => sum + balance, 0n);
      throw new Error(
        total >= units
          ? `Your cash sits in a few places, so one withdrawal can send up to ${usdcDollars(most)}. Ask Auni to gather it first.`
          : `You have ${usdcDollars(total)} in cash to withdraw. Sell something to cash first for more.`,
      );
    }

    let arrives = "In seconds";
    let fee = 0n;
    let bridge: string | null = null;
    if (source !== network) {
      if (source === "solana") throw new Error("Solana cash can only be withdrawn on Solana.");
      const via = firstBridge();
      bridge = via.about.id;
      const quote = await via.bridge
        .quote({
          from: source,
          to: network,
          amount,
          depositor: own.evm ?? "",
          recipient: to,
        })
        .catch(() => {
          throw new Error(
            `Your cash can't move to ${chainName(network)} right now. Try another network, or try again soon.`,
          );
        });
      const received = BigInt(quote.expectedOutputAmount);
      arrives = "In about a minute";
      fee = received < units ? units - received : 0n;
    }
    // On Solana a wallet that pays its own way buys the SOL its fee and any rent need first.
    const topUp =
      network !== "solana" || !own.solana
        ? null
        : source === "solana"
          ? await solFor(await solanaUsdcTransfer(own.solana, to, units), own.solana, {
              spends: units,
            })
          : await solToOpen(own.solana, to);
    const costs =
      fee > 0n
        ? [{ label: "fee to move it between networks", usd: Number(formatUnits(fee, 6)) }]
        : [];
    // Moving between networks costs a little, taken from what arrives.
    const feeLabel = fee > 0n ? dollars(centsToUsd((fee + 9_999n) / 10_000n)) : null;
    const summary = `Withdraw ${dollars(amount)} to ${destinationName(destination, to)} on ${chainName(network)}`;
    const terms: WithdrawalTerms = {
      to: shortAddress(to),
      network: chainName(network),
      arrives,
      fee: feeLabel,
    };
    return withTopUp(
      {
        summary,
        amountUsd: amount,
        card: withdrawalFace(terms, { summary }),
        // Money leaving the owner, for an address code checked: where it goes is pinned as
        // `leavesTo` (see pinnedApproval), never by the agent.
        effect: {
          gives: [{ text: `${dollars(amount)} of USDC on ${chainName(source)}` }],
          gets: [],
          grants: [],
          to: [to],
          ...(costs.length ? { costs } : {}),
        },
        // Where it's paid from, the network it goes on and the bridge it was quoted on; then what
        // the confirm step says beside the card: when it lands, each fee it pays, and the USDC
        // that buys SOL for Solana's fees, pinned with the purchase (withTopUp).
        details: {
          from: source,
          network: terms.network,
          ...(bridge ? { bridge } : {}),
          arrives: terms.arrives,
          ...(terms.fee ? { fee: terms.fee } : {}),
          ...(topUp ? { solForFees: usdcDollars(topUp.usdc) } : {}),
        },
      },
      topUp,
    );
  },
  async execute({ action, input: { amount_usd, network }, wallets }) {
    const to = action.details.leavesTo;
    const source = NETWORK_KEYS.find((chain) => chain === action.details.from);
    if (!to || !source) throw new Error("This withdrawal is missing where it goes.");
    // The address is checked again as when it was proposed, so nothing stored can skip it.
    destinationAddress(network, to, {
      evm: wallets.evmAddress || null,
      solana: wallets.solanaAddress || null,
    });

    const units = parseUnits(amount_usd, 6);
    if (source !== network) {
      if (source === "solana") throw new Error("Solana cash can only be withdrawn on Solana.");
      const { txs } = await quotedBridge(action).send(
        {
          from: source,
          to: network,
          amount: normalizeUsd(amount_usd),
          depositor: wallets.evmAddress,
          recipient: to,
        },
        wallets,
        action,
      );
      // Money leaving is not a trade: no fills, so no specialist's holdings change.
      return { txs, fills: [] };
    }
    if (!isEvmChain(network))
      return { txs: await sendSolanaUsdc(wallets, to, units, action), fills: [] };
    const hash = await wallets.sendEvmTransaction(NETWORKS[network].viem.id, {
      to: NETWORKS[network].usdc,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [to as Address, units],
      }),
    });
    return { txs: [{ chain: network, hash }], fills: [] };
  },
};

/** The bridge a withdrawal's card was quoted on, by the app id it pinned. */
function quotedBridge(approved: Approved) {
  const via = filling("bridge").find(({ about }) => about.id === approved.details.bridge);
  if (!via)
    throw new NothingMoved(
      `The bridge this withdrawal was quoted on (${approved.details.bridge ?? "none"}) isn't here any more. Nothing was sent.`,
    );
  return via.part;
}

function usdcDollars(units: bigint): string {
  return dollars(usdcToUsd(units));
}

/** A USDC transfer on Solana from `from` to `to`, opening the recipient's USDC account first if it has none. */
async function solanaUsdcTransfer(from: string, to: string, units: bigint): Promise<string> {
  const owner = address(from);
  const [source, destination] = await Promise.all([usdcAccountOf(owner), usdcAccountOf(to)]);
  const { value: lifetime } = await solanaKitRpc().getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayer(owner, draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(lifetime, draft),
    (draft) =>
      appendTransactionMessageInstructions(
        [
          opensUsdcAccount(owner, to, destination),
          getTransferCheckedInstruction({
            source,
            mint: SOLANA_USDC.mint,
            destination,
            authority: owner,
            amount: units,
            decimals: SOLANA_USDC.decimals,
          }),
        ],
        draft,
      ),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

/**
 * Sends a USDC transfer on Solana, buying first the SOL its fee and rent need when the wallet
 * pays its own way and holds too little, as its card (`approved`) showed.
 */
async function sendSolanaUsdc(
  wallets: Signer,
  to: string,
  units: bigint,
  approved: Approved,
): Promise<SentTx[]> {
  const from = wallets.solanaAddress;
  if (!from) throw new Error(noAddressOn("Solana"));
  const first = await solanaUsdcTransfer(from, to, units);
  const topUp = await solFor(first, from, { spends: units, approved });
  const txs = topUp ? await topUpSol(wallets, topUp) : [];
  // Built again once SOL is bought, on a blockhash that wait can't have outlived.
  const transfer = topUp ? await solanaUsdcTransfer(from, to, units) : first;
  return [...txs, { chain: "solana", hash: await wallets.sendSolanaTransaction(transfer) }];
}
