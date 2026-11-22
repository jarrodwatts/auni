import type { ActionToolName, CardFace, CashKey, MoneyFlow, MoveRun } from "@auni/shared";
import type { Address, Hex } from "viem";
import type { ZodRawShape, z } from "zod";

import type { ActionRow } from "../db/schema.ts";
import type { Effect } from "./effect.ts";
import type { SolNeed } from "./sol-top-up.ts";
import type { FillKey } from "./fill-key.ts";
import type { Statement } from "./venue-statement.ts";
import type { TypedData } from "./typed-data.ts";

/** A chain where the owner's wallet holds USDC that actions spend (see Network.cash). */
export type FundingChain = CashKey;
/** Where a proposal's cash can wait for its picks: a wallet, or a ledger of an app's own by its app id (see ledgerAt). */
export type CashPlace = FundingChain | (string & {});

/** What the owner's wallet can move on, which a tool's description may depend on. */
export interface Reach {
  /** It holds a Solana key, or there's no wallet yet to say it doesn't. */
  readonly solana: boolean;
}

/**
 * A recipe is one venue's fast path for moving money. The agent calls a
 * recipe's tool with plain parameters; core records an action, asks for
 * permission unless a specialist's rules let it act, and runs `execute` once allowed.
 * Recipes quote fresh inside `execute`: nothing between asking and sending
 * can go stale.
 */
export interface Recipe<Shape extends ZodRawShape = ZodRawShape> {
  /** MCP tool name, e.g. "evm_swap". */
  readonly tool: ActionToolName;
  /**
   * What the agent reads of the tool. A function where that depends on what the owner's wallet
   * can move on (stock_trade's Solana route); null from it where the tool can do nothing for
   * this wallet (one that moves only on Solana, for a wallet with no Solana key), which then
   * isn't offered.
   */
  readonly description: string | ((reach: Reach) => string | null);
  readonly input: Shape;
  readonly venue: string;
  /**
   * The lane one of core's own moves waits its turn in: no two moves that name the same lane run
   * at once, for moves where two at once would race (Monad stock trades, moves between
   * specialists). An app's move names none: the app says `oneAtATime` once for all its moves.
   * Absent or null, the move runs in a lane of its own (see executionLane).
   */
  lane?(action: { readonly details: Record<string, string> }): string | null;
  /**
   * The mark of Auni's own that the card of one of core's moves wears: a stock trade's, a
   * swap's. Without one it wears Auni's. An app's move names none: its card wears its app's.
   */
  readonly mark?: "stocks" | "swap";
  /** The specialist a call names for itself, whatever thread asks; such a call is its own card. */
  filesUnder?(input: z.infer<z.ZodObject<Shape>>): string | undefined;
  /** Sends nothing: execute changes only Auni's records, at once, so one left running moved nothing. */
  readonly offChain?: true;
  /**
   * Which way the call moves a specialist's money, for acting on its own:
   * "buy" puts amountUsd of its cash into a holding, "sell" turns a holding
   * back into cash (the preview's `sells` names which). Absent or null for
   * anything else, which always asks: moving cash between accounts, swapping
   * one holding for another, and leveraged perps, since a pot can budget none
   * of them.
   */
  direction?(input: z.infer<z.ZodObject<Shape>>): "buy" | "sell" | null;
  /** What the permission card and receipt say, before anything runs. */
  describe(
    input: z.infer<z.ZodObject<Shape>>,
    context: {
      readonly specialistHolds?: SpecialistHolds;
      /**
       * The card a failed step was approved at, when it is priced again for a
       * retry: a recipe whose execute holds its price to that card describes
       * it the same way, so the quote and the run never disagree.
       */
      readonly heldTo?: Pick<ActionRow, "details">;
    },
  ): Promise<ActionPreview>;
  /**
   * Where the USDC a recorded action spends sits, all of its amountUsd: a
   * wallet, or a venue's account. Absent or null when it spends
   * something else.
   */
  fundedFrom?(action: {
    readonly input: z.infer<z.ZodObject<Shape>>;
    readonly details: Record<string, string>;
  }): CashPlace | null;
  /**
   * For a move that only takes the owner's cash from one place to another
   * (savings back to the wallet, USDC to another chain, into a venue's account):
   * where it lands. A proposal runs these before the picks they pay for, and
   * its card never shows them.
   */
  readies?(input: z.infer<z.ZodObject<Shape>>): CashPlace | null;
  /**
   * What a recorded move is about, which its card's picture and its opened
   * detail are drawn from. Null when its details pin nothing to name, as a
   * swap's with no token in them.
   */
  about(action: {
    readonly input: z.infer<z.ZodObject<Shape>>;
    readonly details: Record<string, string>;
    readonly amountUsd: string;
  }): Subject | null;
  execute(context: ExecuteContext<z.infer<z.ZodObject<Shape>>>): Promise<ExecuteResult>;
  /**
   * For a move whose money arrives somewhere else a while after it's sent (a
   * bridge, money into or out of a venue's account): whether it has arrived, read
   * once, with a note when it ended some other way. Null while it hasn't. The
   * action stays running until then, so done always means landed.
   */
  landed?(context: LandingContext<z.infer<z.ZodObject<Shape>>>): Promise<Landed | null>;
  /**
   * For a trade: what it bought and sold, read again from the world after its run stopped short
   * of recording it: from its own receipts, or from its venue's record of the order. Reconcile
   * asks only once every send the move kept has confirmed, never about a send that got no answer
   * (only a venue's statement speaks for that), and records what comes back as the run would
   * have (see settleFromReceipts). Null while it can't be told yet. A trade without one is held for the owner instead (see money/life.ts), so every recipe
   * that records fills from what it sent should have one.
   */
  readBack?(context: ReadBackContext<z.infer<z.ZodObject<Shape>>>): Promise<ReadBack | null>;
}

interface ReadBackContext<Input> {
  readonly action: ActionRow;
  readonly input: Input;
  /** The owner's wallets, which sent it; a null one holds no key yet. */
  readonly evmAddress: string | null;
  readonly solanaAddress: string | null;
}

/**
 * What a trade did, read back: its fills, as its run would have returned them (none for a trade
 * that records none, such as one of tokens with no price), or "nothing moved" when its venue
 * says it never took the order.
 */
export type ReadBack = Pick<ExecuteResult, "fills" | "note"> | "nothing moved";

interface LandingContext<Input> {
  readonly action: ActionRow;
  readonly input: Input;
  /** The owner's EVM wallet, which a venue's account and every EVM chain credit. */
  readonly evmAddress: string;
}

export interface Landed {
  /** What didn't go as asked (refunded instead of filled). */
  readonly note?: string;
  /** The transaction that delivered it, by which its arrival is known as this move's (see arrivals.ts). */
  readonly delivered?: string;
  /** What it bought, known only once it landed (a bridge that buys there). Recorded as the move turns done. */
  readonly bought?: readonly Fill[];
}

export interface ActionPreview {
  /** One plain sentence: "Buy about $50 of Nvidia stock". */
  readonly summary: string;
  /**
   * Dollars of the owner's cash the move spends, or for a move of cash itself
   * (a bridge, a deposit), how much it moves; a buy acts on its own only when
   * this fits the specialist's free cash. A sale that `readies` cash
   * (convert_to_cash, a token sold home through a bridge) counts the least it
   * lands, which funding waits on. Never what any other sell or close brings
   * back: that spends nothing, so it is 0. Either way its details'
   * `returnsUsd` says what comes back, which its card shows.
   */
  readonly amountUsd: string;
  /**
   * What it gives, gets and grants (see effect.ts), which decides how it is
   * approved and is every card's lines. A recipe built from fixed contracts
   * declares it; one whose bytes someone else builds declares what Auni asks of
   * them, and holds them to it in a simulation before they are signed.
   */
  readonly effect: Effect;
  /**
   * What code pins when the card is made, kept on the action unchanged: what execute is held
   * to (a bound, an address, a mint) and facts the card shows; the agent reads these too.
   */
  readonly details?: Record<string, string>;
  /**
   * What the move's card says, in the move's own words (see CardFace): its title, button, figures
   * and receipt, with AMOUNT wherever the dollars go, never a dollar figure of its own. Absent
   * for a move that reads well as the plain face core makes from `summary` and `effect`.
   */
  readonly card?: CardFace;
  /**
   * The EVM chain the card's move sends on from the wallet, and the calls it would send as the
   * wallet stands now where describe knows them (a quote that came with its transactions, the
   * agent's own batch). Core asks the chain what the calls cost and, where the wallet is short of
   * the chain's coin, adds buying it to the card or refuses the card; and on a chain whose coin
   * the card's moves leave low, the card first swaps a little cash there for it (see
   * fee-coin.ts). So a recipe never checks fees itself. A move that builds its transactions only
   * as it sends names the chain alone, and is checked as it sends.
   */
  readonly sends?: { readonly chainId: number; readonly calls?: readonly EvmTx[] };
  /**
   * What the SOL its card buys for Solana's fees was sized for, as the card is prepared (set by
   * withTopUp, never stored): a card of several moves buys SOL once, for all of them
   * (buyingSolOnce in sol-top-up.ts).
   */
  readonly buysSol?: SolNeed;
  /**
   * For a sell, the holding and how much of it, as execute will record the
   * fill. A specialist acts on its own only on what it holds, so a sell
   * without one always asks.
   */
  readonly sells?: Sale;
  /**
   * A trade a specialist never makes on its own: a buy of a token with no
   * market price, or one that loses past its venue's limit the moment it
   * fills. Specialists have no loss limit of their own to weigh it by, so the
   * venue's stands in for one.
   */
  readonly unpriced?: "no price" | "loses on fill";
}

/**
 * What a move buys or sells, all things with a price a pick's detail charts:
 * a perp by market, a prediction market's outcome, or a token by chain and
 * address. Each carries what the move puts into it, so its detail can say
 * what that buys.
 */
export type Traded =
  | {
      readonly kind: "perp";
      readonly market: string;
      /** Absent for a move that leaves the position's size alone or shrinks it. */
      readonly opens?: {
        readonly side: "long" | "short";
        readonly leverage: number;
        readonly sizeUsd: number;
        /**
         * How far the price can go against it before its margin is gone, as a share of its
         * entry: 0.32 is 32%. Absent where its venue's move did not pin one.
         */
        readonly liquidationMove?: number;
      };
      /** The position a close lets go of: all of it or a share, and what that locks in. */
      readonly closes?: {
        readonly side: "long" | "short";
        readonly leverage: number;
        readonly sizeUsd: number;
        readonly all: boolean;
        readonly pnlUsd: number;
        /** The position's average entry price as its card was made, where the venue said it. */
        readonly entryUsd?: number;
      };
      /**
       * The stop-loss and take-profit it sets on the position, each by the price that closes it;
       * null for one it removes, absent for one it leaves as it is.
       */
      readonly stops?: {
        readonly stopLoss?: number | null;
        readonly takeProfit?: number | null;
      };
      /** The market's price as its card was made, where the move recorded it. */
      readonly markUsd?: number;
    }
  | {
      readonly kind: "outcome";
      /** A condition id, slug or outcome token id, as its venue's order takes it. */
      readonly market: string;
      readonly outcome?: string;
      /** What buys shares, before fees; 0 for a sell. */
      readonly buysUsd: number;
      /** The market's own picture, pinned when the move was described. */
      readonly image?: string;
    }
  | {
      readonly kind: "token";
      readonly chain: string;
      readonly mint: string;
      /** A stock's ticker ("METAx") or the token's symbol. */
      readonly symbol?: string;
      readonly stock: boolean;
      /** 0 for anything but a buy. */
      readonly buysUsd: number;
    };

/** A move as its pick's detail reads it, when someone opens the pick on its card. */
export type PickedAction = Pick<ActionRow, "tool" | "input" | "details" | "amountUsd" | "status">;

/**
 * What a move is about: something it trades, the owner's own cash where it
 * sits, or an app a raw transaction was built for.
 */
export type Subject =
  | Traded
  /** Cash in the owner's wallets, or at a venue (savings, a perps account), by its app id. */
  | { readonly kind: "cash"; readonly at: "wallet" | (string & {}) }
  | { readonly kind: "app"; readonly name: string; readonly logo: string | null };

/** The token a swap's details pin by chain and address, as every swap records it. */
export function tradedToken(details: Record<string, string>, buysUsd: number): Traded | null {
  const { chain, mint, stock, token } = details;
  return chain && mint
    ? { kind: "token", chain, mint, symbol: stock ?? token, stock: stock !== undefined, buysUsd }
    : null;
}

/** What a recorded action is about, by its recipe; a row's input is what that recipe parsed. */
export function subjectOf(
  recipe: Recipe,
  action: Pick<ActionRow, "input" | "details" | "amountUsd">,
): Subject | null {
  return recipe.about({ ...action, input: action.input as never });
}

/** Dollars a move moves, and which way: in, or back to cash. */
export interface Money {
  readonly flow: MoneyFlow;
  readonly usd: string;
}

/**
 * The money a recorded move moves: back to cash, what a sale brought back
 * (`returnedUsd`, once filled) or a sell or close's preview priced
 * (`returnsUsd`), or in, what a buy spent (`spentUsd`, once filled) or
 * anything else spends at the most its card showed. Null for a move that
 * moves none, like a change of stops.
 */
export function moneyOf(action: Pick<ActionRow, "details" | "run" | "amountUsd">): Money | null {
  const back = action.run.returnedUsd ?? action.details.returnsUsd;
  if (back) return { flow: "back", usd: back };
  return Number(action.amountUsd) > 0
    ? { flow: "in", usd: action.run.spentUsd ?? action.amountUsd }
    : null;
}

/** What a sell sells: resolved the way execute sizes it, and execute never sends more. */
export interface Sale extends FillKey {
  /** In the fill's units: shares, coins or whole tokens. */
  readonly quantity: string;
}

/**
 * What the specialist a move is for holds by its own fills, keyed by
 * `fillIdentity` in `QUANTITY_DECIMALS` units; absent outside a specialist.
 * A sell naming no amount sells only this, so one specialist's "everything"
 * never takes another's shares of the same token unseen.
 */
export type SpecialistHolds = ReadonlyMap<string, bigint>;

interface ExecuteContext<Input> {
  readonly action: ActionRow;
  readonly input: Input;
  readonly specialistHolds?: SpecialistHolds;
  /** Signs and sends with the owner's wallet, through the wallet app. */
  readonly wallets: Signer;
  /**
   * Keeps a move that went out some other way than `wallets` (which keeps its
   * own), the moment the venue takes it: a recipe that fails after it is
   * then settled from its receipts, never reported failed.
   */
  recordSent(tx: KeptTx): Promise<void>;
  /**
   * Posts a move to a venue off chain (an order to its book, a withdrawal it pays out): it is
   * kept as maybe sent, on `chain` with nothing to read, before `post` runs, so a run cut off
   * while the venue hasn't answered is held for the owner, never failed as if nothing went. The
   * mark comes off again when the venue turns the post away, and stays once the venue took it
   * or never answered (MayHaveSent).
   */
  posting<T>(chain: string, post: () => Promise<T>): Promise<T>;
}

export interface SentTx {
  readonly chain: string;
  readonly hash: string;
  /**
   * A step that isn't the move itself (an approval or funding before it; a
   * sweep or refund after it); it alone never settles an action.
   */
  readonly setup?: true;
}

/**
 * A transaction as its action keeps it. A send the wallet took is kept by
 * the wallet's own id for it (walletTxId), so one whose hash never comes
 * back, or that the chain never sees, still counts as sent, and the wallet
 * says what became of it; one a venue's relayer accepted, by the
 * relayer's id, read through the relayer. One a venue took
 * off chain before naming a hash (an order on a venue's book), or one
 * whose answer never came back (see MayHaveSent), is kept with neither: it
 * counts as sent too, with nothing to read until a person does.
 */
export type KeptTx = ActionRow["txs"][number];

export interface ExecuteResult {
  readonly txs: readonly SentTx[];
  readonly fills: readonly Fill[];
  /**
   * For a move that traded on a venue whose statement Auni reads: that
   * statement, which records its fills (see recordOwnFills), so `fills` is
   * empty and what the venue answered never records a trade.
   */
  readonly statement?: Statement;
  /** Part of the call that didn't go through although the move did (a stop that wasn't set). */
  readonly note?: string;
  /**
   * Added to the notes the action keeps of its run (see MoveRun). For a recipe that checks
   * `landed`, what is on its way where (`lands`, "$29.00 on Arbitrum") makes it landing until
   * it arrives. What it filled, in the app's own words, is `filled`. What someone else's
   * transaction pays the owner is known by `delivered`, its
   * hash, or where that can't be learned, `landsUnits`, the exact base units it pays (see
   * arrivals.ts). Anything else is the recipe's own, for its `landed` to read back.
   */
  readonly run?: MoveRun;
  /**
   * Moves its card showed coming after it, which the same tap allowed: each recorded queued in
   * the write that records this run, to run by itself at `at`, in no thread (a bridge out of
   * Solana's rent, back from Circle five days on: apps/across/rent.ts). Only a recipe its app
   * names a "later" tool, never offered to the agent, runs one.
   */
  readonly later?: readonly Later[];
}

/** A move a card showed coming later (see ExecuteResult.later). */
export interface Later {
  readonly tool: string;
  readonly input: Record<string, unknown>;
  /** What it does, as Activity says it once done. */
  readonly summary: string;
  readonly at: Date;
}

/**
 * Thrown by a recipe that sent something but knows nothing moved (an order
 * nobody filled and that was closed): its action fails with this message
 * instead of being settled from its receipts, which would read the sent
 * transactions as a move.
 */
export class NothingMoved extends Error {}

/**
 * Thrown for a move whose card bought the chain's coin for its network fee, when that coin
 * isn't there for it: the purchase went out and its payout hasn't come, was refunded, or no
 * longer covers the fee. The move itself never went, and its card never buys again, so running
 * it again is safe and goes through once the coin is there (see fee-coin.ts).
 */
export class FeesUnpaid extends Error {}

/**
 * A move the wallet can't pay the network fee of, and nothing of the owner's can buy the coin
 * for: a card for it would only fail after the tap. The proposing tool says beside it where
 * fees can be paid now (see fee-coin.ts).
 */
export class NoFeeCoin extends Error {}

/**
 * Thrown where a send may have reached the venue and its answer never came
 * back (a timeout, a server error): it may have gone. Its action keeps `sent`
 * as sent, so it stays running and settles like any other send, never failed
 * as if nothing moved, which would have the person send it again. A venue
 * turning it away, or a failure before it left, is a plain error.
 */
export class MayHaveSent extends Error {
  readonly sent: KeptTx;

  constructor(sent: KeptTx, venue: string, cause: unknown) {
    super(`${venue} didn't confirm it, so it may have gone through (${String(cause)}).`, {
      cause,
    });
    this.sent = sent;
  }
}

/** What one trade moved; its key comes from the helpers in fill-key.ts. */
export interface Fill extends FillKey {
  readonly side: "buy" | "sell";
  readonly quantity: string;
  readonly usdValue: string;
}

export interface Signer {
  readonly evmAddress: string;
  readonly solanaAddress: string;
  /** A list goes out as one transaction, all or nothing, with its hash. */
  sendEvmTransaction(chainId: number, tx: EvmTx | readonly EvmTx[]): Promise<string>;
  /** Takes typed data as walletDocument shapes it for the wallet. */
  signEvmTypedData(document: TypedData): Promise<string>;
  /**
   * Kept as setup when it says so, like an EvmTx. A wallet with a sponsor has it pay unless the
   * transaction pays its own fee and rent: one someone else signed, which a sponsor's fee payer
   * would void, or one Auni won't pay for. That one goes as built, with the wallet as its fee
   * payer, as every one does from a wallet with no sponsor.
   */
  sendSolanaTransaction(
    base64Tx: string,
    options?: {
      readonly setup?: true;
      readonly paysOwnFee?: true;
      /** As EvmTx.buysFees: this send buys the SOL the move's fees are paid in. */
      readonly buysFees?: string;
    },
  ): Promise<string>;
}

export interface EvmTx {
  readonly to: string;
  readonly data?: string;
  readonly value?: string;
  /** An approval before the move itself, recorded as such. */
  readonly setup?: true;
  /**
   * Set on the calls that buy the coin a chain's fees are paid in (fee-coin.ts, sol-top-up.ts),
   * to the pay-in service's id for the order, or "swap" for a swap on the chain itself. The
   * wallet a move is handed keeps such a send as its card's purchase and lets a card make one,
   * ever (payingFees).
   */
  readonly buysFees?: string;
}

/**
 * The one transaction a wallet sends for a move's EVM calls, said with nothing signed, so what
 * it costs can be asked of the chain before the owner has allowed it (see ownGas in gas.ts).
 */
export interface EvmSend {
  readonly to: Address;
  readonly data?: Hex;
  /** The chain's coin the transaction itself carries, in wei. */
  readonly value: bigint;
  /**
   * The account code this send puts the wallet's address under, by an EIP-7702 authorization
   * it carries, when the address doesn't run that code yet (see account-code.ts).
   */
  readonly delegates?: Address;
}
