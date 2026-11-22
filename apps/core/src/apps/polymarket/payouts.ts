import type { VenueToolName } from "@auni/shared";
import { isAddressEqual, parseAbi, parseEventLogs, type Address, type Log } from "viem";

import { publicClient } from "../../money/chains.ts";
import { fillIdentity, QUANTITY_DECIMALS } from "../../money/fill-key.ts";
import type { Payout } from "../contract.ts";
import { listedPositions, lostForGood } from "./holdings.ts";
import { CONTRACTS, dataRows } from "./http.ts";
import { outcomeKey } from "./keys.ts";
import { resolveMarket } from "./markets.ts";
import { toMicros } from "./orders.ts";
import { depositWallet } from "./wallet.ts";

/**
 * Polymarket pays out a resolved market by itself: its AutoRedeemer, which a
 * buy's setup lets redeem the wallet's shares (see autoRedeemCalls), burns
 * them and pays the deposit wallet pUSD, with no move of Auni's. Core records
 * each payout under this tool (see money/payouts.ts).
 */
export const PAYOUT_TOOL = "polymarket_payout" satisfies VenueToolName;

const autoRedeemerEvents = parseAbi([
  "event Redemption(address indexed from, uint256 indexed positionId, uint256 payout)",
  "event BinaryRedemption(address indexed from, bytes32 indexed conditionId, uint256 payout)",
  "event NegRiskRedemption(address indexed from, bytes32 indexed conditionId, uint256 payout)",
]);
const sharesEvents = parseAbi([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
]);

/** Shares carry six decimals on chain; fills weigh them in QUANTITY_DECIMALS. */
const SHARE_SCALE = 10n ** BigInt(QUANTITY_DECIMALS - 6);

/**
 * What Polymarket paid out since `since` for the `open` outcomes (by fillIdentity) in the
 * deposit wallet of `owner`, one per transaction, passing by those `recorded` (see
 * Payouts.read), then each market resolved against them (see polymarketLosses). Its activity
 * only hints at a redemption: what it burned and paid is read from its transaction on chain.
 * Throws when a hint or the chain can't be read.
 */
export async function polymarketPayouts(
  owner: string,
  open: ReadonlySet<string>,
  since: number,
  recorded: ReadonlySet<string>,
): Promise<Payout[]> {
  const wallet = await depositWallet(owner);
  if (!wallet.deployed) return [];
  const found: Payout[] = [];
  for (const hash of await redemptionHashes(wallet.address, since)) {
    if (recorded.has(hash)) continue;
    const markets = await paidOut(hash, wallet.address, open);
    if (markets.length > 0) found.push({ hash, chain: "polygon", markets });
  }
  return [...found, ...(await polymarketLosses(wallet.address, open))];
}

/**
 * The markets resolved against `open` outcomes in the wallet, each a payout of nothing with no
 * transaction. Polymarket's AutoRedeemer redeems only shares that pay, so a losing bet's shares
 * sit in the wallet for good, worth nothing, and nothing else would ever close them in the books
 * or say the bet lost. The data API's word that they're worthless is checked against the
 * market's own winner, so a market still open, or one that split 50-50, is never taken for lost.
 */
async function polymarketLosses(wallet: Address, open: ReadonlySet<string>): Promise<Payout[]> {
  const lost = (await listedPositions(wallet)).filter(
    (position) => lostForGood(position) && open.has(fillIdentity(outcomeKey(position.token_id))),
  );
  const payouts = await Promise.all(
    lost.map(async (position): Promise<Payout | null> => {
      const market = await resolveMarket(position.condition_id);
      const tokenId = BigInt(position.token_id);
      const winners = market.tokens.filter((token) => token.winner);
      if (winners.length === 0 || winners.some((token) => token.tokenId === tokenId)) return null;
      const share = {
        key: outcomeKey(tokenId),
        burned: toMicros(position.current_size) * SHARE_SCALE,
        paidMicros: 0n,
      };
      return {
        hash: null,
        chain: "polygon",
        markets: [{ question: market.question, paidMicros: 0n, shares: [share] }],
      };
    }),
  );
  return payouts.filter((payout) => payout !== null);
}

/**
 * The transactions Polymarket's activity lists as redeeming the wallet's shares since `since`
 * (its own payouts among them), oldest first.
 */
async function redemptionHashes(wallet: Address, since: number): Promise<string[]> {
  const rows = await dataRows<{ transaction_hash?: string }>("/v2/activity", {
    user: wallet,
    type: "REDEEM",
    // 0 would mean three years back, the API's default.
    start: String(Math.max(1, Math.floor(since / 1000))),
    sort_by: "TIMESTAMP",
    sort_direction: "ASC",
  });
  const hashes = new Set<string>();
  for (const { transaction_hash: hash } of rows)
    if (hash && /^0x[0-9a-fA-F]{64}$/u.test(hash)) hashes.add(hash.toLowerCase());
  return [...hashes];
}

/** What one market's payout closes: each outcome's shares it burned, and what they were paid. */
type MarketPayout = Payout["markets"][number];

/**
 * What the AutoRedeemer paid the wallet in this transaction, per market, for
 * markets whose burned shares the fills hold: read from its own events,
 * which name the wallet, the market and the pUSD paid, and the share
 * contracts' transfers out of the wallet, which say how many it burned. A
 * market's payout goes to its winning outcome's shares, by how many of each;
 * with no winner named (a 50-50 resolution) to every outcome's alike.
 */
async function paidOut(
  hash: string,
  wallet: Address,
  open: ReadonlySet<string>,
): Promise<MarketPayout[]> {
  const receipt = await publicClient("polygon").getTransactionReceipt({
    hash: hash as `0x${string}`,
  });
  if (receipt.status !== "success") return [];
  const burned = burnedShares(receipt.logs, wallet);
  const holds = (tokenId: bigint) => open.has(fillIdentity(outcomeKey(tokenId)));
  if (![...burned.keys()].some(holds)) return [];
  const redemptions = parseEventLogs({
    abi: autoRedeemerEvents,
    logs: receipt.logs.filter((entry) => isAddressEqual(entry.address, CONTRACTS.autoRedeemer)),
  }).filter((event) => isAddressEqual(event.args.from, wallet));
  const markets = await Promise.all(
    redemptions.map(async (event): Promise<MarketPayout | null> => {
      const v2 = event.eventName === "Redemption";
      if (v2 && !holds(event.args.positionId)) return null;
      const market = await resolveMarket(
        v2 ? event.args.positionId.toString() : event.args.conditionId,
      );
      const tokens = market.tokens.filter(
        ({ tokenId }) => (!v2 || tokenId === event.args.positionId) && burned.has(tokenId),
      );
      if (!tokens.some(({ tokenId }) => holds(tokenId))) return null;
      const winners = tokens.filter((token) => token.winner);
      const paying = winners.length > 0 ? winners : tokens;
      const paidShares = paying.reduce((sum, { tokenId }) => sum + (burned.get(tokenId) ?? 0n), 0n);
      return {
        question: market.question,
        paidMicros: event.args.payout,
        shares: tokens.map(({ tokenId }) => {
          const shares = burned.get(tokenId) ?? 0n;
          const pays = paying.some((token) => token.tokenId === tokenId) && paidShares > 0n;
          return {
            key: outcomeKey(tokenId),
            burned: shares * SHARE_SCALE,
            paidMicros: pays ? (event.args.payout * shares) / paidShares : 0n,
          };
        }),
      };
    }),
  );
  return markets.filter((market) => market !== null);
}

/** Shares the transaction moved out of the wallet on either share contract, by token id. */
function burnedShares(logs: readonly Log[], wallet: Address): Map<bigint, bigint> {
  const burned = new Map<bigint, bigint>();
  const add = (id: bigint, value: bigint) => {
    if (value > 0n) burned.set(id, (burned.get(id) ?? 0n) + value);
  };
  const transfers = parseEventLogs({
    abi: sharesEvents,
    logs: logs.filter((entry) =>
      [CONTRACTS.conditionalTokens, CONTRACTS.positionManager].some((shares) =>
        isAddressEqual(entry.address, shares),
      ),
    ),
  });
  for (const transfer of transfers) {
    if (!isAddressEqual(transfer.args.from, wallet)) continue;
    if (transfer.eventName === "TransferSingle") add(transfer.args.id, transfer.args.value);
    else transfer.args.ids.forEach((id, index) => add(id, transfer.args.values[index] ?? 0n));
  }
  return burned;
}
