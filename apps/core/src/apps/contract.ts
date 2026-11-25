import type {
  ActionToolName,
  BrainModelWire,
  EvmChainKey,
  AppAbout,
  FailureKind,
  NetworkKey,
  PickDetailWire,
  VenueToolName,
  StartingLine,
} from "@auni/shared";
import { firstThatFits } from "@auni/shared";
import type { Address as SolanaAddress } from "@solana/kit";
import type { Address, Hex } from "viem";
import type { ZodType } from "zod";

import type { AuniTool } from "../agent/tool.ts";
import type { Box } from "../agent/box.ts";
import type { Job } from "../jobs/queue.ts";
import type { Approved } from "../money/approved.ts";
import type { FillKey } from "../money/fill-key.ts";
import type { PayInAnswer, PayInRequest, PayInStanding } from "../money/pay-in.ts";
import type { PricePoint, Step, TokenPrice } from "../money/history.ts";
import type { Holding } from "../money/portfolio.ts";
import type { PrivateField } from "../private-fields.ts";
import type {
  EvmSend,
  EvmTx,
  FundingChain,
  PickedAction,
  Recipe,
  SentTx,
  Signer,
  Traded,
} from "../money/recipe.ts";
import type { EvmQuoteRequest, EvmRoute } from "../money/swaps/evm.ts";
import type { XStock } from "../money/swaps/xstocks.ts";
import type { Statement } from "../money/venue-statement.ts";
import type { Simulated } from "../money/wallet-effect.ts";
import type { KeyTried } from "../try-key.ts";
import type { SignerOptions } from "../money/wallets.ts";

/**
 * One service Auni works with, as a folder in apps/: what it can do, each part optional, all
 * on one level. Apps only propose; core decides, and the wallet signs only what the person
 * allowed. An app imports core and never another app; core reaches apps only through
 * registry.ts.
 */
export interface App {
  /** Its about.ts, which the web reads as data. */
  readonly about: AppAbout;

  // What the agent knows and can do there.
  /**
   * What it adds to Auni's reach, in a sentence or two of the system prompt's "What Auni does":
   * "Perps trade on Hyperliquid." Plain words for the agent, naming its tools where they help.
   */
  readonly guide?: string;
  /** Read-only lookups any turn may call; a function, so an app missing its key gives none. */
  readonly lookups?: () => readonly AuniTool[];
  /** Its money tools; each recipe's `venue` is this app's id (apps.test.ts checks). */
  readonly moves?: readonly Recipe[];
  /**
   * Its moves run one after another, never two at once, for a service where two would race (an
   * exchange that sets a market's leverage before an order places). Said once for every move,
   * so a move added later is covered too (see executionLane); a move never names its own lane.
   */
  readonly oneAtATime?: true;
  /**
   * Why the service takes no new positions from this machine now, for one that decides by where
   * the machine is (Polymarket goes by its internet address); null while it takes them, and when
   * it can't tell, so a check that can't be reached changes nothing. Keep the answer a while:
   * core asks before every card that buys there. While it says so, core makes no card with a buy
   * there (a move whose `direction` is "buy") and runs none already allowed (money/actions.ts),
   * and the app's sheet says it.
   */
  noNewPositions?(): Promise<NoNewPositions | null>;
  /**
   * What it sees that matters to the owner now, read fresh each time and never kept as memory
   * (see facts.ts). Read-only: it reads the world and writes nothing. Core cuts it off after a
   * few seconds and aborts `signal`.
   */
  readonly facts?: (seen: OwnerSeen, signal: AbortSignal) => Promise<readonly AppFact[]>;

  // How what happens there reads.
  /**
   * What some addresses on `chain` are to the owner ("an Across bridge"), by lowercased address.
   * A transaction the agent builds whose every call goes to one of them, or approves one to
   * spend a token, is this app's: its card wears the app's name and logo, whatever name the
   * agent gave it (money/readers.ts).
   */
  addresses?(chain: EvmChainKey, owner: Address): Promise<ReadonlyMap<string, string>>;
  /**
   * The few words for a transaction the agent built whose every call is to one of its
   * `addresses` or an approval for one, read from the calls and what their simulation saw; null for one it doesn't
   * know. Synchronous, and it reads only what it is handed. It names the card and picks its
   * layout, and nothing more: every amount, what is sent and got, and whether the card takes a
   * tap or the owner's proof all come from the simulation alone (money/readers.ts).
   */
  reads?(chain: EvmChainKey, calls: readonly BuiltCall[], seen: Simulated): Reading | null;
  /** What the service says when it refuses, as the owner should hear it (see Problems). */
  readonly problems?: Problems;

  // What it keeps for the owner.
  /** Where the owner's money sits there, and how it reads (see Account). */
  readonly account?: Account;

  // A job it does for Auni itself.
  /** An EVM swap route core's swaps ask for quotes, alongside every other route. */
  readonly swaps?: SwapRoute;
  /** Solana tokens: their listings and prices, and swaps between them. */
  readonly solana?: SolanaRoute;
  /** Moves the owner's cash between chains, for core's own moves (withdrawals, paying a card). */
  readonly bridge?: Bridge;
  /** Quotes carrying USDC from another chain to an address of the owner's (see PayIn). */
  readonly payIn?: PayIn;
  /** Says what tokens are and what they are worth (see Tokens). */
  readonly tokens?: Tokens;
  /** Watches the world for something, and says when a watch's condition came true. */
  readonly watches?: Source;
  /** Thinks: runs each turn of a conversation on the owner's own AI (see agent/brain.ts). */
  readonly brain?: Brain;
  /** Holds the owner's wallets and signs for them; core uses one (see theWallet). */
  readonly wallet?: WalletProvider;
  /** A place the owner talks to Auni besides the web app, such as a chat app (see channels/). */
  readonly channel?: Channel;

  /**
   * Tries a secret the owner typed for one of its settings (`key`, as `about.settings` names
   * it) before Auni saves it, with the service's cheapest call that needs it (see ../try-key.ts):
   * one it refused isn't saved. Its other settings are read as they are now; null while one it
   * is tried with isn't there yet (it is tried as the last comes in). Every app with a secret
   * setting has one (apps/try-key.test.ts).
   */
  tryKey?(key: string, value: string): Promise<KeyTried | null>;

  /**
   * A send its relayer took (KeptTx.relayerId) that has no hash yet, as the relayer tells it
   * now: its hash once it has one, or failed when it never lands.
   */
  relayed?(id: string): Promise<{ readonly hash: string } | "pending" | "failed">;
  /**
   * Background work of its own, which core's job runner runs beside core's (jobs/queue.ts):
   * each kind is named "<id>:<name>", so no two apps' kinds meet. Tables it keeps are in its
   * folder's tables.ts, each named "<id>_<name>".
   */
  readonly jobs?: readonly Job<unknown>[];
}

/** Why a service takes no new positions from here, as the owner and the agent read it. */
export interface NoNewPositions {
  /** A few words for its tile: "No new bets from here". */
  readonly short: string;
  /**
   * The sentence: what the service refuses, where, and what still works there. Never a way round
   * the rule (another machine, another place): Auni keeps to it.
   */
  readonly says: string;
}

/** What core tells an app of the owner, so it can look at what matters to them. */
export interface OwnerSeen {
  /** What they hold besides cash, largest first: "ETH", "Ethereum", "1204.50", and its logo. */
  readonly holdings: readonly {
    readonly symbol: string;
    readonly name: string;
    readonly usdValue: string;
    readonly image: string | null;
  }[];
}

/** One thing an app sees, which core cites as this app's (it sets the app itself). */
export interface AppFact {
  /** What it sees, as one sentence the agent reads as data: 'On Polymarket, "Will X?" is at 62% Yes.' */
  readonly text: string;
  /** What a starting point that came from it cites: the question, "BTC on Hyperliquid". */
  readonly label: string;
  /** Where the owner can see it for themselves, or null. */
  readonly link: string | null;
  /**
   * A picture of what it's about (a coin's logo, a market's own image, as the service publishes
   * it), on a host the web may draw (`servableImage`: core's, or one its about's `images` names);
   * null for none. A starting point about the fact wears it.
   */
  readonly image: string | null;
  /** Ways the owner might start a chat from it, best first, for when no brain writes them. */
  readonly starts: readonly FactStart[];
}

/**
 * A chat started from a fact, as one line in two parts that fit one row together (`lineFits` in
 * @auni/shared): what's true ("PUMP fell 16.7% today.") and what to do ("Why?"), then the
 * message a tap sends.
 */
export interface FactStart extends StartingLine {
  readonly prompt: string;
}

/**
 * A fact's start, said the first of `lines` ways that fits one row whole, fullest first; none
 * when no way fits, since a line is never cut short to fit.
 */
export function startFrom(prompt: string, lines: readonly StartingLine[]): FactStart[] {
  const line = firstThatFits(lines);
  return line ? [{ ...line, prompt }] : [];
}

export const defineApp = (app: App): App => app;

/** One call of a transaction the agent built, as send_evm_transaction sends it. */
export interface BuiltCall {
  readonly to: Address;
  readonly data: Hex;
  /** The chain's coin it sends, in wei. */
  readonly value: bigint;
}

/** What an app's reader says of a transaction the agent built (see App.reads). */
export interface Reading {
  /**
   * The card's title, with no dollar amount in it: "Stake ETH with Lido". Left out where the
   * layout its verb draws names the card better from the simulation ("Sell ETH" for a swap).
   */
  readonly title?: string;
  /**
   * "swap", "deposit" or "move" (a bridge) draw that layout when the simulation fits it; any
   * other word draws the plain one under the app's name.
   */
  readonly verb: string;
  /** For a move, the chain it lands on: "base". */
  readonly toChain?: string;
  /** One line no simulation can show: "Turning stETH back into ETH can take days." */
  readonly finePrint?: string;
}

/**
 * What a service says when it refuses a move, and how the owner should hear each refusal. The
 * move's own code reads the service's answer with `said` and throws `refused` of what it says
 * (money/refused.ts), so a refusal the app knows fails the move in the owner's words, with the
 * reason its card needs to offer the right next step, and any other says what the service said.
 */
export interface Problems {
  /**
   * What an answer of the service says went wrong, in the service's own words: the same
   * function the app's code reads a live answer with. Undefined for an answer that refuses
   * nothing.
   */
  said(answer: unknown): string | undefined;
  /** The refusals it knows, the first that matches winning: put a narrow one before a wide one. */
  readonly known: readonly Problem[];
}

/** One refusal an app knows. */
export interface Problem {
  /**
   * An answer that refuses this way, as the service gave it: a file in the app's folder holding
   * { "from": where it was recorded or which page of the service's docs gives it, "answer": the
   * answer }. apps.test.ts reads each through `said` and fails one its own `when` doesn't
   * match, or an earlier row's does. That proves the words still fit a recorded answer; nothing
   * here can prove the service still says them.
   */
  readonly example: string;
  /** What the service's words for it look like. */
  readonly when: RegExp;
  /** Why the move stopped, which decides what its card offers next (failureKindSchema). */
  readonly kind: FailureKind;
  /**
   * The refusal as the owner reads it on the card and in a channel, and as the agent is told
   * it: what happened and what became of their money, in a sentence or two of plain words,
   * 200 characters at most. What the agent should do next is for the app's SKILL.md.
   */
  readonly say: string;
}

/**
 * Where the owner's money sits at an app, and how it reads: the one way an app slots into
 * the portfolio, whatever it is (a vault's shares, savings, a perps account, outcome shares).
 * Core prices and names what the account owns through it, and never through a token feed.
 */
export interface Account {
  /**
   * Where that money is kept, which decides who reads it, and which holdings are the account's
   * own. Each way of keeping says its own in the form that fits it, so core can list and
   * compare what accounts own (accountOwning in registry.ts; apps.test.ts holds that none owns
   * a chain's coin, a dollar token or what another account owns).
   */
  readonly kept:
    /**
     * As tokens in the owner's own wallet (a vault's shares, a savings token): every one of
     * them, listed. Core reads each balance itself, as it reads any wallet token, and since the
     * account vouches for each, one sent in from anywhere is recognised and counted.
     */
    | { readonly wallet: readonly AccountToken[] }
    /**
     * In a ledger of the app's own, on no chain (a perps account). Core files its holdings,
     * fills and cash under the app's id, so everything filed there is its own, and a send there
     * has no chain receipt to read. Only this means "this place is not a chain" (see ledgerAt
     * in registry.ts).
     */
    | { readonly ledger: (owner: Address) => Promise<readonly AccountHolding[]> }
    /**
     * In contracts on these chains that are not the owner's wallet (a deposit wallet of its
     * own). Core reads each chain by itself, so one chain's outage hides only its own.
     */
    | {
        readonly chains: readonly EvmChainKey[];
        read(owner: Address, chain: EvmChainKey): Promise<readonly AccountHolding[]>;
        /**
         * Whether a key on one of those chains is its own: a set too open to list (every
         * outcome a market could ever mint), told by its shape.
         */
        owns(key: FillKey): boolean;
      };
  /** What one of its holdings is worth, now and over time. Left out when each is a dollar. */
  readonly prices?: Prices;
  /** How one of its holdings reads in the portfolio: its name, a line under it, its picture. */
  face(holding: Holding): Promise<HoldingFace>;
  /**
   * One of its markets as a person reads it, whether or not the owner holds it: what it tracks,
   * its ticker and its picture, for a move's name and its card. Left out when its holdings are
   * not positions in markets it names.
   */
  market?(instrument: string): Promise<MarketFace>;
  /**
   * How money gets there, and how it comes back to the wallet: the move that does it, or, where
   * there is none, the plain words the owner reads instead.
   */
  readonly moneyIn: Recipe | string;
  readonly moneyOut: Recipe | string;
  /** Its positions are leveraged: each can be short, and is worth its margin plus what it made. */
  readonly margined?: true;
  /** How cash waiting there counts; left out when it keeps none. */
  readonly cash?: AccountCash;
  /** Its own record of what traded there, a liquidation included, which core reads on (statements.ts). */
  statement?(owner: Address): Statement;
  /** What it paid out by itself for positions the books still hold (payouts.ts). */
  readonly payouts?: Payouts;
  /** What one of its picks shows when opened on a card; null when it has nothing to chart. */
  detail?(subject: Traded, action: PickedAction): Promise<PickDetailWire | null>;
  /**
   * What it trades under a theme or name, for find_instruments, which names each by the app's
   * name. `tickers` are those other searches turned up for the same theme (NVDA for Nvidia), which
   * it may match too.
   */
  find?(
    terms: readonly string[],
    tickers: () => Promise<readonly string[]>,
  ): Promise<readonly Found[]>;
}

/** A token an account keeps in the owner's wallet: where it is, and the symbol it goes by. */
export interface AccountToken extends FillKey {
  readonly chain: EvmChainKey;
  readonly symbol: string;
}

/** A holding an account reads; core files it under the app's id. */
export type AccountHolding = Omit<RawHolding, "venue">;

/** A holding as the portfolio shows it: its name, the line under it, and its picture. */
export interface HoldingFace {
  readonly name: string;
  readonly detail: string;
  /** Its own picture; null for the app's logo. */
  readonly logoUrl: string | null;
}

/** A market as a person reads it: what it tracks, its ticker and its picture. */
export interface MarketFace {
  readonly name: string;
  readonly ticker: string;
  readonly logoUrl: string;
}

/**
 * The three ways cash at an app counts. Core's funding knows these three and no other: a
 * fourth is a change to core's money code.
 */
export type AccountCash =
  /** In the account's ledger, which its picks spend from. Only with `kept.ledger`. */
  | {
      readonly kind: "ledger";
      /** The account's free cash now, in cents. */
      free(owner: Address): Promise<bigint>;
      /** What taking cash out of the account costs, in dollars. */
      readonly outFeeUsd: number;
    }
  /** Dollar tokens on a chain, which a buy there spends before the wallet's own. */
  | {
      readonly kind: "chain";
      readonly chain: FundingChain;
      /** The tokens it is held as, which no withdrawal may be sent to. */
      readonly tokens: readonly Address[];
      /** How much a buy can spend now, in cents. */
      free(owner: Address): Promise<bigint>;
    }
  /**
   * Put away to earn, as a wallet token counted as cash at a dollar until it is taken out: each
   * whole unit must be worth one USDC, as an Aave aToken is, growing in number as it earns.
   * Shares priced by a rate (an ERC-4626 vault's) are a holding the account prices, not cash.
   */
  | {
      readonly kind: "savings";
      /** Where it is kept on `chain`; null where it has no market. */
      token(chain: string): SavingsToken | null;
    };

/** Savings on one chain: where cash goes in and pays out from, and the token it is held as. */
export interface SavingsToken {
  readonly pool: Address;
  readonly token: Address;
  /** "aUSDC". */
  readonly symbol: string;
}

/** What an app paid out by itself, and the recorded tool each payout is kept under. */
export interface Payouts {
  /** The recorded tool a payout is kept under, as a done move of its own. */
  readonly tool: VenueToolName;
  /**
   * What it paid out for the holdings still `open` in the books (by fillIdentity) since `since`
   * (milliseconds), one per transaction, passing by those `recorded` (by lowercased hash), and
   * each market resolved against them that pays them nothing.
   */
  read(
    owner: Address,
    open: ReadonlySet<string>,
    since: number,
    recorded: ReadonlySet<string>,
  ): Promise<readonly Payout[]>;
}

/** Something to buy, as the app that trades it lists it for find_instruments. */
export type Found = Omit<Instrument, "venue">;

/** A holding read before pricing: raw base units, priced later unless its dollar value is known. */
export interface RawHolding extends Omit<Holding, "usdValue" | "quantity"> {
  readonly baseUnits: bigint;
  /** The base units its price counts, where they aren't its balance (an xStock's shares). */
  readonly pricedUnits?: bigint;
  readonly usdValue?: string;
}

/** What prices an account's holdings, by instrument. */
export interface Prices {
  /** An instrument's price now; undefined when it has none. */
  live(instrument: string): Promise<number | undefined>;
  /**
   * Its price from `from` (milliseconds) to now, a point each step, oldest first: the
   * portfolio's chart reads by Step, a pick's detail by the day.
   */
  history(instrument: string, step: Step | "1d", from: number): Promise<PricePoint[]>;
}

/** Something to buy, as find_instruments lists it. */
export interface Instrument {
  /**
   * What it is, in a word whoever lists it gives ("perp", "prediction"): Claude reads it, and
   * core asks nothing of it. Core's own finds are a "stock" or a "token".
   */
  readonly kind: string;
  readonly name: string;
  readonly ticker: string;
  /** Who trades it, by name. */
  readonly venue: string;
  readonly chain: string;
  /** The money tool that trades it. */
  readonly tool: ActionToolName;
  /** What that tool takes to name it: a stock's symbol, a perp's market, a prediction's event, a mint. */
  readonly identifier: string;
  readonly price: number | null;
  readonly liquidityUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly logoUrl: string | null;
  /** Stocks only: what a $25 buy costs on Monad now, as its card would say, or what Monad said. */
  readonly monad?: string;
  /** Prediction markets only: the priced outcomes and the token each one trades as. */
  readonly outcomes?: readonly {
    readonly name: string;
    readonly price: number;
    readonly tokenId: string;
  }[];
}

/**
 * One transaction's payouts: per market, the shares it burned and what each was paid. Or a
 * market resolved against shares nobody redeems, which pay nothing for good: no transaction, and
 * the shares still held stand in for burned.
 */
export interface Payout {
  /** Lowercased; null for shares lost with nothing sent. */
  readonly hash: string | null;
  readonly chain: EvmChainKey;
  readonly markets: readonly {
    readonly question: string;
    /** What the market paid, in USDC micros. */
    readonly paidMicros: bigint;
    readonly shares: readonly {
      readonly key: FillKey;
      /** In QUANTITY_DECIMALS units: burned, or for a loss nobody redeems, held. */
      readonly burned: bigint;
      readonly paidMicros: bigint;
    }[];
  }[];
}

/** Moves the owner's USDC between their own chains, or to an address on another. */
/**
 * The most a move of cash between wallets may lose on the way, in basis points: Across's fee is
 * under 2% even for $2 to Ethereum, and far less to anywhere else. A bridge's card says the
 * least it lands (APPROVED_PROCEEDS) by this, execute holds it there, and a card's funding counts
 * that as what arrives (money/funding.ts).
 */
export const BRIDGE_LOSS_BPS = 300n;

export interface Bridge {
  /** Its money tool, which a card pays with to bring cash or a holding across. */
  readonly recipe: Recipe;
  /**
   * Its tool's input for a leg core adds to a card by itself: `amount` (whole units) of the
   * owner's cash from one of their chains to another, or with `token` that much of a token
   * held on `from`, sold as it leaves so that cash lands.
   */
  input(leg: BridgeLeg): Record<string, unknown>;
  /** What would land, in the landing USDC's base units, quoted fresh and signed by no one. */
  quote(transfer: BridgeTransfer): Promise<{ readonly expectedOutputAmount: string }>;
  /** Quotes again and sends; with `approved`, nothing goes once it lands less than the card said. */
  send(
    transfer: BridgeTransfer,
    wallets: Signer,
    approved?: Approved,
  ): Promise<{ readonly txs: readonly SentTx[] }>;
}

export interface BridgeLeg {
  readonly from: string;
  readonly to: string;
  readonly amount: string;
  /** The token sold on `from`, by its address or mint; left out, the owner's cash moves. */
  readonly token?: string;
}

export interface BridgeTransfer {
  readonly from: NetworkKey;
  readonly to: NetworkKey;
  /** USDC leaving, in whole units ("12.5"). */
  readonly amount: string;
  /** Whose wallet it leaves. */
  readonly depositor: string;
  /** Who receives it: the owner's own wallet, or a withdrawal's destination. */
  readonly recipient: string;
}

/** Solana tokens: their listings, their prices, and swaps between them. */
/**
 * Quotes carrying USDC or a chain's own coin from one chain to a recipient on another as steps the
 * sender's own wallet sends: the SOL a wallet that pays its own Solana fees buys with its USDC on
 * Monad, and the coin an EVM chain's fees are paid in, bought from a chain that can pay. It only
 * asks its service and reads the answer. Core holds every quote to what was asked before anyone
 * sees or signs it (money/pay-in.ts), by the two things it says of its own contract here.
 */
export interface PayIn {
  /** The one contract a quote may approve and deposit into, at this address on every chain it serves. */
  readonly depository: Address;
  /**
   * A call to the depository, read as the deposit it makes; throws for any other call. A
   * deposit of the chain's own coin is of `value`, the coin the call carries, and its token is
   * "native".
   */
  deposit(
    data: Hex,
    value: bigint,
  ): {
    readonly depositor: Address;
    readonly token: Address | "native";
    readonly amount: bigint;
  };
  /** Its service's quote as answered; throws PayInRefused when it didn't answer or turned the ask away. */
  quote(request: PayInRequest): Promise<PayInAnswer>;
  /**
   * Where a request it quoted stands: final only as success, refunded or failed. A success
   * names the transactions that paid the recipient (see PayInStanding).
   */
  status(requestId: Hex): Promise<PayInStanding>;
}

export interface SolanaRoute {
  /** Tokens by symbol, name or mint, most relevant first. */
  search(text: string): Promise<SolanaToken[]>;
  /** These mints' listings, as many as it lists. */
  tokens(mints: readonly string[]): Promise<SolanaToken[]>;
  /** A token's price now; throws when it has none. */
  price(mint: string): Promise<SolanaPrice>;
  quote(request: SolanaQuoteRequest): Promise<SolanaQuote>;
  /** The swap as one transaction for `taker` to sign, with the quote it was built at. */
  build(
    request: SolanaQuoteRequest & { readonly taker: SolanaAddress },
  ): Promise<{ readonly quote: SolanaQuote; readonly transactionBase64: string }>;
}

export interface SolanaToken {
  readonly mint: SolanaAddress;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  readonly tokenProgram: SolanaAddress;
  readonly usdPrice: number | null;
  readonly liquidityUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly logoUrl: string | null;
  readonly verified: boolean;
  /** How much of its trading the listing counts as real people's, above zero once any is. */
  readonly organicScore: number;
  readonly tags: readonly string[];
}

/**
 * A token's price, as Auni values what it holds and what a trade gets: for an xStock, its
 * share's price rather than its token's last swap.
 */
export interface SolanaPrice {
  /** Dollars per token as a wallet shows it: for an xStock, one share. */
  readonly usdPrice: number;
  /** Token-2022 scaled-UI multiplier (xStocks): wallet amount = raw amount * multiplier. */
  readonly multiplier: number;
}

export interface SolanaQuoteRequest {
  readonly inputMint: string;
  readonly outputMint: string;
  readonly amount: bigint;
  readonly slippageBps: number;
}

export interface SolanaQuote {
  readonly inAmount: bigint;
  readonly outAmount: bigint;
  readonly minOutAmount: bigint;
  readonly priceImpactPct: number;
  /** The pools it goes through, as the route names them. */
  readonly route: string;
}

/**
 * Says what tokens are and what they are worth, for every token no app's account owns. Each
 * member is optional, since a feed knows only some of this. Core asks the apps that fill the role
 * in the order order.ts gives and takes the first answer (money/token-feeds.ts), so a feed
 * only ever fills what the ones asked before it left out, and none has a switch.
 *
 * A price id is core's own: "<chain>:<address>" for a token ("monad:0x…", "solana:<mint>", and
 * "eip155:<chain id>:0x…" on a chain Auni has no name for, whose own coin is the zero address
 * there), "coingecko:<slug>" for the coin of a chain Auni names. A feed that names tokens
 * another way translates. A `chain` is core's name for one, as a holding's is ("monad",
 * "solana", "eip155:43114").
 */
export interface Tokens {
  /**
   * Dollars per whole token by price id, now, or with `at` as it was near then. One it doesn't
   * price, or keeps no past price of, is left out; it throws when it can't be read. Core asks
   * the first feed for up to 100 ids a call, and each later feed for one id no feed before it
   * priced, so one failing lookup costs only its own.
   */
  prices?(ids: readonly string[], at?: Date): Promise<ReadonlyMap<string, TokenPrice>>;
  /**
   * One token's price from `from` (milliseconds) to now, a point each step, oldest first; empty
   * when it keeps none. The portfolio's chart reads by Step, a pick's detail by the day.
   */
  history?(id: string, step: Step | "2h" | "1d", from: number): Promise<PricePoint[]>;
  /** A token's price now and its percent change over the last day, for a pick's detail. */
  day?(id: string): Promise<{ readonly price?: number; readonly today?: number }>;
  /**
   * What a token on an EVM chain is, by its address or by a symbol the feed knows there (the
   * chain's own coin by EVM_NATIVE or its symbol); null for one it doesn't list.
   */
  listing?(chain: string, token: string): Promise<TokenListing | null>;
  /** A token's picture, by its address; null when it has none. */
  logo?(chain: string, token: string): Promise<string | null>;
  /**
   * Every token it lists on a chain, by lowercased address; empty for a chain it has no list
   * for. Being on a list is what tells a known token from one anyone could mint and price from
   * a pool they seeded, so it throws while it can't say, and never guesses. What a list calls a
   * token is what Auni calls it wherever it shows (money/holdings.ts, tokenCalled).
   */
  listed?(chain: string): Promise<ReadonlyMap<string, ListedToken>>;
  /**
   * The tokenized stocks it catalogs. It throws while it has never read them: a stock's token
   * is valued by knowing it is one, so "none" is never a guess.
   */
  stocks?(): Promise<readonly XStock[]>;
  /**
   * What it says of a stock's market while that isn't open, as a sentence that follows another
   * (" Backed lists NVDA's market as closed until …"); empty while it is open, or when it
   * can't say.
   */
  marketNote?(stock: XStock): Promise<string>;
}

/** A token on a feed's list: its symbol, and its name ("Tether Gold Tokens"). */
export interface ListedToken {
  readonly symbol: string;
  readonly name: string;
}

/** A token as a feed lists it. Its symbol is the listing's word, which names nothing by itself. */
export interface TokenListing {
  readonly address: string;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** Dollars per whole token; null when it lists the token with no price. */
  readonly usdPrice: number | null;
}

export interface SwapRoute {
  /** any: any pair on an EVM cash chain. stocks: Monad xStocks against USDC only. */
  readonly trades: "any" | "stocks";
  /**
   * The exact trade asked for, or a throw whose message is the route's plain
   * reason ("no book for this stock"), which reaches the agent after its name.
   */
  quote(request: EvmQuoteRequest): Promise<EvmRoute>;
  /** Stocks it has order books for at any size, by symbol (NVDAx), which stock_trade names. */
  readonly books?: readonly string[];
}

/** The owner's two addresses; null for a kind the wallet holds no key of (an import may skip one). */
export interface WalletAddresses {
  readonly evm: string | null;
  readonly solana: string | null;
}

/** The owner's private keys: EVM as 0x hex, Solana as the base58 64-byte secret. */
export interface WalletKeys {
  readonly evm: string | null;
  readonly solana: string | null;
}

/**
 * Where the owner's money is kept, and what signs for it. Core hands it only
 * moves the owner allowed (money/actions.ts), each checked against its card.
 * The wallet is made only when the owner chooses, in setup: `create`, or
 * `bring` for keys they already hold.
 */
export interface WalletProvider {
  /** Core uses this wallet when WALLET names no app; exactly one sets it (apps.test.ts). */
  readonly byDefault?: true;
  /**
   * The owner's addresses, both null until there is a wallet: asking never makes one. The sweep
   * and readings ask each minute, so it stays cheap once there is one.
   */
  addresses(): Promise<WalletAddresses>;
  /** Makes the owner's wallet, once: throws WalletExists when there is one. */
  create(): Promise<WalletAddresses>;
  /** Takes in keys the owner already holds, typed into a private field, while there's no wallet. */
  readonly bring?: PrivateField;
  /**
   * Takes in a Solana key the owner already holds beside the EVM key the wallet holds alone,
   * typed into a private field: added, never in place of a key it holds, and refused once it
   * holds a Solana key. Core offers it only then, by its own id, and only to a request that proves
   * the owner is there (money/wallets.ts). Absent for a wallet that makes its own keys.
   */
  readonly bringSolana?: Omit<PrivateField, "id" | "proof">;
  /**
   * Makes the one key the wallet lacks beside the one it holds (a Solana key beside an EVM key
   * brought on its own), never changing a key it holds: throws WalletExists when it holds both,
   * and NoWallet with neither. Absent for a wallet that always holds both.
   */
  addMissing?(): Promise<WalletAddresses>;
  /**
   * A sponsor, not the wallet, pays a send's network fees on `chain` (an EVM chain's id, or
   * Solana, with the rent of accounts a move opens). Absent: the wallet pays its own everywhere.
   */
  sponsored?(chain: number | "solana"): boolean;
  /**
   * Signs and sends one allowed move, waiting until each send lands. A list of EVM calls goes as
   * one transaction, all or nothing, since its card judged it as one.
   */
  signer(options: SignerOptions): Promise<Signer>;
  /**
   * The one transaction `signer` would send for these EVM calls from `owner`, said with nothing
   * signed: core asks the chain what it costs before a card is shown, and the wallet again
   * before it signs (../money/gas.ts), so the two agree. Null where it can't send them as one.
   * Absent: Auni can't say what this wallet's sends cost, so a card shows no network fee and a
   * wallet short of the chain's coin is refused only by the node.
   */
  asSent?(chainId: number, owner: Address, txs: readonly EvmTx[]): Promise<EvmSend | null>;
  /**
   * A send kept by the wallet's own id (KeptTx.walletTxId) that the chain can't answer for
   * yet, as the wallet tells it now: its hash once it has one, or failed when it never lands.
   */
  sendStatus(walletTxId: string): Promise<{ readonly hash: string } | "pending" | "failed">;
  /**
   * Delivers again whatever this wallet signed that no node answered for: the same bytes, never
   * a second signing. Core calls it as it starts, so a send cut off by a crash between signing
   * and broadcasting goes out. Only a wallet that signs and broadcasts itself needs it.
   */
  resend?(): Promise<void>;
  /** The owner's keys, behind the owner's proof (setup's backup, Settings); throws with no wallet. */
  revealKeys(): Promise<WalletKeys>;
  /**
   * The owner's keys as this machine keeps them, for `auni doctor`, `auni uninstall` and a move
   * to another machine (move/): where they are (never the keys), null while there are none, their
   * removal for good, which only `auni uninstall` asks for, once the owner has typed that they
   * mean it, and keeping keys a move carried in. Absent for a wallet whose keys aren't kept on
   * this machine.
   */
  readonly keptHere?: {
    where(): Promise<KeptKeys | null>;
    remove(): Promise<void>;
    /**
     * Keeps keys carried here from the owner's other machine by `auni move-in`, once that
     * machine has stopped for good; throws WalletExists when this machine holds keys already.
     */
    keep(keys: WalletKeys): Promise<void>;
  };
}

/** Where a wallet's keys are kept on this machine, said without them. */
export interface KeptKeys {
  /** In words: `in the OS keychain, as "wallet-keys:/home/me/.auni" under "auni"`. */
  readonly place: string;
  /** Whether removing the data folder removes them too. */
  readonly inDataFolder: boolean;
}

/** There is a wallet already, so none was made. */
export class WalletExists extends Error {
  constructor() {
    super("There is a wallet already, so none was made.");
  }
}

/** There is no wallet yet: one is made with the owner's first take, unless they bring theirs. */
export class NoWallet extends Error {
  constructor() {
    super("There's no wallet yet: Auni makes one with your first take.");
  }
}

/**
 * The agent loop: the owner's own AI CLI, run on this machine with their own login. A brain only
 * turns its CLI's output into BrainEvents; core seals cards, runs the tools and renders the stream
 * (agent/translate.ts), so what a brain writes can never show a card core didn't make.
 */
export interface Brain {
  /**
   * Can it think on this machine right now? Makes no model call, so it costs nothing, and so can
   * only see that a login is there: core asks one tiny question (`run`) before it calls a brain
   * ready, and a `refused` event says what this should have said. Stops its CLI when `signal`
   * aborts: core gives up on a check after 20 seconds.
   */
  check(signal: AbortSignal): Promise<BrainCheck>;
  /** One turn. Ends with exactly one `done` or `error`, and stops when `signal` aborts. */
  run(turn: BrainTurn, signal: AbortSignal): AsyncIterable<BrainEvent>;
  /** Folders and files holding this CLI's login; every brain's box hides every brain's. */
  secrets(): readonly string[];
  /**
   * The command that opens this CLI in the owner's own terminal, on their own login and settings,
   * starting on `prompt`: `auni triage` runs it, never a turn. Where the CLI can hold itself to
   * it, the session can't read `hidden` (files and folders) and asks before it changes anything.
   * Null where the owner has no such CLI installed.
   */
  terminal(prompt: string, hidden: readonly string[]): readonly string[] | null;
  /**
   * Signs the owner in from the web app, as its CLI's own sign-in would in their terminal, and
   * resolves once the CLI says it is done (agent/sign-in.ts runs it, and checks again after).
   * The CLI keeps what it gets in its own store; nothing of it passes back through here. Rejects
   * with the CLI's own words for what went wrong, which the owner reads. Stops when `signal` aborts.
   */
  signIn?(attempt: SignInAttempt): Promise<void>;
  /**
   * Installs its CLI into Auni's own tools folder (`toolsDir()`), for a `not-installed` check
   * this can fix; absent when what is missing is the owner's to install.
   */
  install?(signal: AbortSignal): Promise<void>;
  /** The system prompt's words for what its computer can do: "a sandboxed shell … web search". */
  readonly computer: string;
  /** Whose models think, as the agent may say when sincerely asked: "Anthropic's Claude models". */
  readonly models: string;
}

/**
 * What a sign-in shows the owner: a page to open on any device and the code to enter there, or
 * the CLI's own prompt as a terminal shows it: the command as the owner would type it, and
 * everything it has printed so far.
 */
export type SignInShows =
  | { readonly kind: "code"; readonly url: string; readonly code: string }
  | { readonly kind: "terminal"; readonly command: string; readonly output: string };

/** One sign-in a brain runs: what the owner sees as it changes, and what they type into it. */
export interface SignInAttempt {
  readonly signal: AbortSignal;
  /** What the owner sees now, on every open device. */
  show(view: SignInShows): void;
  /**
   * Hands each line the owner types (to a terminal view) to `write`, which gives it to the CLI's
   * prompt alone: never kept, logged, put in an error, or shown to anyone.
   */
  onTyped(write: (line: string) => void): void;
}

/** How hard a turn thinks; each brain maps a role to one of its models. */
export type Role = "deep" | "everyday" | "fast";

export type BrainCheck =
  /**
   * `login` names the credential, as the owner knows it: "your Claude Max subscription", and
   * `signedInAs` the account, where the CLI names one (an email), which only the owner's screens
   * show, never the agent. `models` lists the models and reasoning efforts this brain offers.
   */
  | {
      readonly ready: true;
      readonly login: string;
      readonly signedInAs?: string;
      readonly models?: readonly BrainModelWire[];
    }
  /**
   * Why it can't think yet: its CLI (or what its box needs) isn't installed, the owner isn't
   * signed in, the sign-in it keeps has expired, or it fails some other way. `fix` is the
   * command the owner runs themselves: "claude auth login".
   */
  | { readonly ready: false; readonly why: BrainNotReady; readonly fix: string };

export type BrainNotReady = "not-installed" | "signed-out" | "expired" | "broken";

export interface BrainTurn {
  readonly systemPrompt: string;
  /** The history, one block per message, then this turn's context and message. */
  readonly prompt: readonly string[];
  readonly role: Role;
  /** Explicit model chosen by the owner for this thread; falls back to `role` when unset. */
  readonly model?: string;
  /** Explicit reasoning effort chosen by the owner for this thread; falls back to `role` when unset. */
  readonly effort?: string;
  /** What the brain's tools may touch on this machine. */
  readonly box: Box;
  /** Auni's tools: core's MCP server and this turn's token for it; null for no tools at all. */
  readonly mcp: { readonly url: string; readonly token: string } | null;
  /** A JSON Schema the answer must fit; `done.output` is then the parsed object. */
  readonly outputSchema?: Record<string, unknown>;
}

/**
 * A turn as it happens, the same for every brain. Tools go by the names the web shows: Auni's by
 * their bare names, the CLI's own as Bash, Read, WebSearch and WebFetch.
 */
export type BrainEvent =
  /** The CLI is up; `login` is where this turn's credential actually came from. */
  | { readonly type: "ready"; readonly model: string; readonly login: string }
  | { readonly type: "text"; readonly id: string; readonly delta: string }
  | { readonly type: "thinking"; readonly id: string; readonly delta: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  /** `output` is the tool's structured result when it has one, otherwise its text. */
  | {
      readonly type: "tool-result";
      readonly id: string;
      readonly output: unknown;
      readonly isError: boolean;
    }
  /** The owner's plan is out of turns until `resetsAt` (null when the CLI didn't say). */
  | { readonly type: "limit"; readonly resetsAt: Date | null }
  /**
   * Its login was refused (a key that doesn't work, a login that expired): why it can't think,
   * and the fix, as `check` would give them. Core shows the brain so until it thinks again.
   */
  | { readonly type: "refused"; readonly why: BrainNotReady; readonly fix: string }
  | { readonly type: "done"; readonly output?: unknown }
  | { readonly type: "error"; readonly message: string };

/**
 * A kind of thing Auni can watch the world for: prices, the news. The hub (automations/) keeps
 * each watch, records each fire once, folds a story told already, holds to the cooldown and the
 * day's cap, saves cursors and renews leases; a source only says what a condition is and when
 * one came true. Its fires arrive by `run`, a stream or a poll Auni keeps open; a service that
 * evaluates conditions itself also leases each watch from it (`remote`).
 */
export interface Source {
  /**
   * Plain words for the agent: what it can watch, how to write a condition, what each costs. Its
   * first sentence says what it watches and what that costs, and the watch tool's description
   * lists each source by it; the whole guide, with the condition's JSON Schema, is the watch
   * tool's answer to action guide, and comes with any condition the source can't read.
   */
  readonly guide: string;
  /** A watch's condition, in the source's own shape. */
  readonly condition: ZodType<Record<string, unknown>>;
  /** It has what it needs on this machine; until then the agent isn't offered it. */
  configured(): boolean;
  /**
   * Throws WatchRefused for a condition it can't watch, beyond its shape: a market it doesn't
   * list, a name the service can't resolve. Its message reaches the agent, to reshape and retry.
   */
  check?(condition: Record<string, unknown>): Promise<void>;
  /**
   * Whether the condition comes true again and again by itself, as a schedule does ("every
   * Friday at 5pm"). Its watch then keeps firing, with no cooldown, unless the agent gives one;
   * any other watch fires once unless the agent asks it to repeat.
   */
  recurs?(condition: Record<string, unknown>): boolean;
  /**
   * Its fires are times the owner asked to be woken at (a reminder, a routine at 5pm), not news
   * of the world, so each wakes the thread it was set in, at whatever hour: triage doesn't weigh
   * it, and the day's cap on repeating watches doesn't quiet it. A watch on the world leaves it
   * out, since there judging what is noise is the point.
   */
  readonly alwaysWakes?: true;
  /**
   * Fires as they happen, until `signal` aborts. One that ends or throws early (a dropped
   * connection) is started again after a pause, with `since` to catch up from.
   */
  run(context: SourceRun): AsyncIterable<SourceBatch>;
  /** For a service that evaluates conditions itself, which Auni leases a watch from. */
  readonly remote?: RemoteWatching;
}

export interface SourceRun {
  /**
   * The source's active watches as they stand now; ask again each time, as they change. A watch
   * set up, changed or resumed shows here within moments.
   */
  watches(): readonly SourceWatch[];
  /** Reads them again now: for a fire naming a watch watches() doesn't hold, just set up maybe. */
  refresh(): Promise<readonly SourceWatch[]>;
  /** The last batch's cursor, saved once its fires were recorded; null the first time. */
  readonly cursor: string | null;
  /** When that cursor was saved: anything that happened since is caught up on, as late. */
  readonly since: Date | null;
  readonly signal: AbortSignal;
}

/** One watch as its source sees it. */
export interface SourceWatch {
  readonly id: string;
  readonly condition: Record<string, unknown>;
  /** The service's own id for it (RemoteWatching), or null. */
  readonly ref: string | null;
  /** When it was set up: nothing before this counts for it. */
  readonly since: Date;
}

/** Fires the hub records, then the cursor it saves: a batch of none just marks progress. */
export interface SourceBatch {
  readonly fires: readonly SourceFire[];
  readonly cursor: string;
}

/** A watch's condition came true. */
export interface SourceFire {
  readonly watchId: string;
  /**
   * Unique among this watch's fires, and the same each time one fire is told (live, caught up
   * after a restart, redelivered), so it is recorded and wakes the thread once.
   */
  readonly id: string;
  /** When it happened. */
  readonly at: Date;
  /** Found catching up after Auni was asleep or offline, so it is news from then, not now. */
  readonly late?: true;
  /** What happened, as data the agent reads and never takes instructions from. */
  readonly report: Record<string, unknown>;
  /** The story it is about: further reports of one story are recorded without waking anyone. */
  readonly story?: string;
}

/**
 * Watches the service keeps for Auni, each for a while: the hub renews a lease before it ends,
 * and replaces a watch the service says has stopped.
 */
export interface RemoteWatching {
  /** Starts watching; throws OutOfCredits while the account can't pay, and is asked again later. */
  watch(watch: RemoteWatchSpec): Promise<{ readonly ref: string; readonly until: Date }>;
  /** Stops a watch; one already stopped is fine. */
  unwatch(ref: string): Promise<void>;
  /** Whether it still watches: false once the service ended or failed it. */
  watching(ref: string): Promise<boolean>;
}

export interface RemoteWatchSpec {
  readonly id: string;
  /** The line the owner sees, and the agent's note on why it matters. */
  readonly description: string;
  readonly note: string;
  readonly condition: Record<string, unknown>;
  /** The least time between fires of a watch that repeats; null for one that fires once. */
  readonly cooldownMs: number | null;
  /** When the watch ends; null to watch until deleted. */
  readonly expiresAt: Date | null;
}

/**
 * A chat app the owner talks to Auni in. It only carries messages: core's hub (channels/hub.ts)
 * decides who the owner is, which conversation a message joins, and draws every message and
 * button it sends from its own records, so nothing the agent writes can become a button.
 */
export interface Channel {
  /** It has what it needs to connect (a bot token); unset, the hub leaves it off. */
  configured(): boolean;
  /**
   * Connects outbound, so no public URL is needed, and hands the hub each event in the order it
   * arrived, until `signal` aborts. A press is answered with what `receive` returns.
   */
  listen(
    receive: (event: ChannelEvent) => Promise<string | void>,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Sends a message to a chat: the refs of the messages it took, the buttons under the last. A ref,
   * like an event's `id`, is never another message's, even after the owner moves to a new bot or
   * account, since the hub keys replies and cards by it for good.
   */
  send(chat: string, message: ChannelMessage, replyTo?: string): Promise<readonly string[]>;
  /**
   * Replaces what one sent message shows, with a message that fits in one (the hub draws every
   * card to, see channels/draw.ts): false when it never can again (the owner deleted it, or it was
   * sent from another account), so the hub stops keeping it in step.
   */
  edit(ref: string, message: ChannelMessage): Promise<boolean>;
  /** Shows the chat that an answer is being written. */
  typing(chat: string): Promise<void>;
  /** Acknowledges a message the hub accepted from the owner. */
  acknowledge?(ref: string): Promise<void>;
  /** How the owner sends this pairing code from the app: a link that opens the chat with it. */
  pairingHint(code: string): Promise<string>;
}

/**
 * What arrives on a channel, as the service vouches for it: `from` is the sender's stable id,
 * `chat` the conversation it came in, `direct` whether that is a one-to-one chat with Auni.
 */
export type ChannelEvent =
  | {
      readonly kind: "message";
      /** Stable across redeliveries of the same message, and never another message's. */
      readonly id: string;
      readonly from: string;
      readonly chat: string;
      readonly direct: boolean;
      readonly text: string;
      /** The sent message (a ref `send` returned) this one replies to. */
      readonly replyTo: string | null;
    }
  | {
      /**
       * The chat app's own way to open a chat with a bot or ask how it works (Telegram's /start
       * and /help): the hub answers it, and the agent never hears of it.
       */
      readonly kind: "hello";
      readonly from: string;
      readonly chat: string;
      readonly direct: boolean;
      /** The pairing code the link that opened the chat carried, if it did. */
      readonly code: string | null;
      readonly command?: "pending" | "portfolio";
    }
  | {
      readonly kind: "press";
      readonly from: string;
      readonly chat: string;
      readonly direct: boolean;
      /** The message whose button was pressed, as `send` returned it. */
      readonly message: string;
      /** The button's `press`, exactly as the hub drew it. */
      readonly data: string;
      /** Show the decision before the card is redrawn, when the channel supports it. */
      readonly answer?: (text: string) => void;
    };

export interface ChannelMessage {
  /**
   * Markdown, as the agent writes it; the channel renders what it can of it. A mark after a
   * backslash is the mark itself, which is how core draws words from outside (`literal`).
   */
  readonly text: string;
  /** More Markdown the channel can fold under the message, with a short heading first. */
  readonly detail?: string;
  /** Rows of buttons under it. */
  readonly buttons?: readonly (readonly ChannelButton[])[];
}

export type ChannelButton =
  /** `press` (at most 64 characters) comes back as a press event's `data`. */
  | { readonly label: string; readonly press: string }
  | { readonly label: string; readonly copy: string }
  | { readonly label: string; readonly url: string };

/** The source won't watch this condition: it's malformed, or names something it doesn't know. */
export class WatchRefused extends Error {}

/** The service's account can't pay for this until it's topped up. */
export class OutOfCredits extends Error {}
