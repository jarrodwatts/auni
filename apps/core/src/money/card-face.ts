import {
  AMOUNT,
  CARD_FORMAT,
  formatExactUsd,
  isAsk,
  LETS_LINE,
  permissionsSaid,
  SUMMARY_VERBS,
  type ActionCardWire,
  type CardFace,
} from "@auni/shared";

import type { ActionRow } from "../db/schema.ts";
import type { AppLogo } from "./app-logo.ts";
import { letsSaid, sentTo, type Effect } from "./effect.ts";
import { moneyOf, type ActionPreview } from "./recipe.ts";
import { parseUnits } from "./usd.ts";

// What a money card says (see CardFace in @auni/shared), for the moves core makes itself: a
// trade, a withdrawal, a transaction the agent built for an app it named, and the plain face of
// any move that writes none of its own. An app's move writes its face in its own folder. No
// face types a dollar figure of the card's amount: it says AMOUNT where the amount goes, and
// fillFace puts in the amount core priced.

type Figure = CardFace["figures"][number];

/** A face's figures, in order, without those that have nothing to say. */
export function figures(...entries: readonly (Figure | null)[]): Figure[] {
  return entries.filter((entry): entry is Figure => entry !== null && !!entry.value);
}

function sentence(...parts: readonly (string | null)[]): string | null {
  return parts.filter(Boolean).join(" ") || null;
}

/** What a face needs to know of the card it is written for, beyond its own numbers. */
interface Said {
  /** Core's plain sentence for the move. */
  readonly summary: string;
  /** Whether the card moves any money: one that moves none says no amount anywhere. */
  readonly moves: boolean;
}

/** What a face is told of the preview it is written for (see Said). */
function saidOf(preview: Pick<ActionPreview, "summary" | "amountUsd" | "details">): Said {
  const money = moneyOf({ amountUsd: preview.amountUsd, details: preview.details ?? {}, run: {} });
  return { summary: preview.summary, moves: parseUnits(money?.usd ?? "0", 6) !== 0n };
}

/** A preview with the face `write` gives it, told what its card says of its money (see Said). */
export function withFace(preview: ActionPreview, write: (said: Said) => CardFace): ActionPreview {
  return { ...preview, card: write(saidOf(preview)) };
}

/** A buy or a sale of a token or a tokenized stock, as the swap priced it. */
export interface TradeTerms {
  readonly side: "buy" | "sell";
  /** The token's ticker: "NVDAx", "JUP". */
  readonly symbol: string;
  /**
   * What a token that isn't a stock is called, which the card says with its symbol beside it
   * ("Tether Gold", "XAUt0 on Monad"); absent or null for one that goes by its symbol.
   */
  readonly name?: string | null;
  /** The services it goes through, in the owner's words (see throughOf in swaps/evm.ts). */
  readonly through?: string | null;
  /**
   * A tokenized stock reads as shares of the company, by its name with its ticker beside it,
   * whichever chain it settles on: "Coinbase", "COIN".
   */
  readonly stock: { readonly company: string; readonly ticker: string } | null;
  /** Auni's key ("monad", "solana"), or the chain's own name for any other. */
  readonly chain: string;
  /** A buy's estimate of the tokens it gets: "0.27"; a sell's with no worst case, named: "1.75 USDT". */
  readonly receive: string | null;
  /** Tokens going out: a sell's, or what a buy pays when it isn't dollars: "1.5 NVDAx". */
  readonly selling: string | null;
  /** A sell's worst case: "$48.10", or "48.1 USDC". */
  readonly atLeast: string | null;
  /** One token's price now: "$184.20". */
  readonly price: string | null;
  /** Everything it costs, network fees and what it loses to the market: "$0.65 ($0.25 network fee, $0.40 price move)". */
  readonly costs: string | null;
}

const CHAINS: Record<string, string> = { monad: "Monad", solana: "Solana" };

export function tradeFace(terms: TradeTerms, said: Pick<Said, "moves">): CardFace {
  // A tokenized stock reads as the company; its token ticker ("NVDAx") means nothing to a person.
  const name = terms.stock?.company ?? terms.name ?? terms.symbol;
  const chain = CHAINS[terms.chain] ?? terms.chain;
  // Which chain a stock settles on is plumbing; a person owns the stock, which its ticker names.
  const context = terms.stock
    ? `${terms.stock.ticker}, a tokenized stock`
    : terms.name
      ? `${terms.symbol} on ${chain}`
      : `On ${chain}`;
  const price = terms.price;
  const through = terms.through ? { label: "Through", value: terms.through } : null;
  if (terms.side === "sell") {
    return {
      title: `Sell ${name}`,
      // A sale that couldn't be priced has no amount to name, so it names what it sells.
      action: said.moves ? `Sell ${AMOUNT}` : `Sell ${name}`,
      working: `Selling ${name}`,
      context,
      figures: figures(
        terms.selling ? { label: "You sell", value: terms.selling } : null,
        terms.atLeast
          ? { label: "You get, at least", value: terms.atLeast }
          : terms.receive
            ? { label: "You get, about", value: terms.receive }
            : null,
        price ? { label: "Price", value: price } : null,
        terms.costs ? { label: "Costs", value: terms.costs } : null,
        through,
      ),
      finePrint: null,
      price,
      receipt: { title: `Sold ${name}`, detail: context, amount: "back" },
    };
  }
  const receive = terms.receive
    ? terms.stock
      ? `${terms.receive} shares`
      : `${terms.receive} ${terms.symbol}`
    : null;
  return {
    title: `Buy ${name} for ${AMOUNT}`,
    action: `Buy ${AMOUNT}`,
    working: `Buying ${name}`,
    context,
    figures: figures(
      // A trade of one token for another pays in the token, not dollars.
      { label: "You pay", value: terms.selling ?? AMOUNT },
      receive ? { label: "You get, about", value: receive } : null,
      price ? { label: "Price", value: price } : null,
      terms.costs ? { label: "Costs", value: terms.costs } : null,
      through,
    ),
    finePrint: null,
    price,
    receipt: {
      title: `Bought ${name}`,
      detail: receive ? `About ${receive}` : context,
      amount: "spent",
    },
  };
}

/** Cash leaving Auni, as the withdrawal priced it. */
export interface WithdrawalTerms {
  /** The destination, shortened: "0x1a2B…fa0b". */
  readonly to: string;
  readonly network: string;
  /** When it lands: "In seconds", "In about a minute". */
  readonly arrives: string;
  /** What moving it between networks costs, taken from what arrives: "$0.07". */
  readonly fee: string | null;
}

/** Cash leaving Auni: where it goes, on which network, and when it gets there. */
export function withdrawalFace(terms: WithdrawalTerms, said: Pick<Said, "summary">): CardFace {
  return {
    title: said.summary,
    action: `Withdraw ${AMOUNT}`,
    working: "Sending it out",
    context: null,
    figures: figures(
      { label: "To", value: terms.to },
      { label: "Network", value: terms.network },
      { label: "Arrives", value: terms.arrives },
    ),
    // The SOL a withdrawal on Solana buys for its fee is said as every card's purchase of a
    // fee's coin is (fee-coin-said.ts), not here.
    finePrint: terms.fee ? `Includes a ${terms.fee} fee to move it between networks.` : null,
    receipt: {
      title: said.summary.replace(/^Withdraw\b/u, "Withdrew"),
      detail: `To ${terms.to}`,
      amount: null,
    },
  };
}

/** One token a transaction sends or gets: "18.97" "WPRL" "Wrapped Pearl" "$25.00". */
interface AppLeg {
  readonly amount: string;
  readonly symbol: string;
  readonly name: string | null;
  /** What it is worth at the market price; null when it has none. */
  readonly usd: string | null;
}

/**
 * A transaction the agent built for an app it named. The name, site and logo only dress the
 * card and are never checked; every number is the simulation's.
 */
export interface AppTerms {
  readonly app: string;
  /** Its site, bare: "example.org". */
  readonly site: string | null;
  readonly logo: AppLogo | null;
  /** The card the agent's word for it draws, when the simulation fits; null is the plain one. */
  readonly layout: "buy" | "sell" | "deposit" | "move" | null;
  readonly chain: string;
  /** Where a move lands: "Ethereum". */
  readonly toChain: string | null;
  readonly sends: readonly AppLeg[];
  readonly gets: readonly AppLeg[];
  /** One token's price as the trade pays it: "$1.318". */
  readonly price: string | null;
  /** What comes back against what goes, at market prices: "0.4% worse". */
  readonly vsMarket: string | null;
  /** The gas the wallet pays itself, in dollars: "$0.80". */
  readonly networkFee: string | null;
  /** A permission it leaves behind, as what it lets someone do: "0x1a2b…9f8e spend your USDC". */
  readonly leaves: string | null;
  /** Whose wallets what it sends goes to, as the simulation saw; empty when Auni can't name them. */
  readonly to: readonly string[];
  /** The contract it calls, so a misnamed app can be spotted: "0x1a2b…9f8e". */
  readonly via: string;
  /** The title the app that read it gave, which names the card in any layout; null for none. */
  readonly title: string | null;
  /** A line from the app that read it, that no simulation shows; null for none. */
  readonly finePrint: string | null;
  /** Whether an app whose own contracts the transaction calls named it, and not the agent. */
  readonly vouched: boolean;
  /** The agent's own sentence about it, which nothing checked; null for none. */
  readonly note: string | null;
  /** The app of Auni's the agent's name is, which doesn't know this contract; null for none. */
  readonly unknownTo: string | null;
}

const leg = ({ amount, symbol }: AppLeg) => `${amount} ${symbol}`;

/**
 * What one token is worth, said beside it, or that Auni can't price it, where a card would
 * otherwise leave its worth to be guessed; several together aren't summed.
 */
const worth = (legs: readonly AppLeg[]) =>
  legs.length === 1 ? (legs[0]!.usd ?? "Auni can't price it") : null;

/**
 * A transaction the agent built for an app it named, in that app's colours. The
 * layout is core's, which drew it only when the simulation fit; every number
 * is the simulation's at market prices. A permission left behind is always said.
 */
export function appFace(terms: AppTerms, said: Said): CardFace {
  return {
    ...appWords(terms, said),
    ...(terms.title ? { title: terms.title } : {}),
    logo: logoOf(terms),
    ...(terms.vouched ? {} : { checks: checksOf(terms) }),
  };
}

/** The heading over what a simulation showed, on a card nothing else vouches for. */
const CHECKED = "Checked by running it first";
/** The heading over the agent's own sentence there, which says what it is before it is read. */
const UNCHECKED = "Not checked: what Auni says about it";

/**
 * What a card no app vouches for says of itself (see CardFace.checks): which of its words Auni
 * checked, the agent's sentence apart from them, and why it reads this way. The app's name is
 * the agent's word, so the line that uses it claims nothing about the app.
 */
function checksOf({ app, note, unknownTo }: AppTerms): NonNullable<CardFace["checks"]> {
  return {
    checked: CHECKED,
    unchecked: note ? { heading: UNCHECKED, says: note } : null,
    why: unknownTo
      ? `Auni's ${unknownTo} app doesn't know this contract, so Auni read this by running it first.`
      : `No app for ${app} yet, so Auni read this by running it first.`,
  };
}

/**
 * The app's own mark, which its card wears whatever the transaction trades: its logo, or with
 * none its name alone, so a stake and its unstake both wear the service's initial and never the
 * initials of the token each trades.
 */
function logoOf({ logo, app }: AppTerms): NonNullable<CardFace["logo"]> {
  return { src: logo?.src ?? null, inset: logo?.inset ?? false, name: app.slice(0, 40) };
}

function appWords(terms: AppTerms, said: Said): CardFace {
  const act = (verb: string) => (said.moves ? `${verb} ${AMOUNT}` : verb);
  const onChain = `${terms.app} on ${terms.chain}`;
  // A permission it leaves is said by withPermissions, as on every card.
  const safe = terms.leaves ? null : "Nothing is left able to spend your money afterwards.";
  const fee = terms.networkFee ? `Network fee about ${terms.networkFee}.` : null;
  // The app's name may be the agent's word, so the contract it calls is said too, to catch a misnamed one.
  const via = sentence(terms.finePrint, `It goes through ${terms.via}.`);
  const [sent, got] = [terms.sends[0], terms.gets[0]];
  // What leaves and arrives, as the simulation saw it. The card's amount is what leaves at
  // the listed prices (see leavesUsd), so the two can't disagree.
  const sends = (label: string) =>
    terms.sends.length
      ? { label, value: terms.sends.map(leg).join(", "), note: worth(terms.sends) }
      : null;
  const gets = (label: string) =>
    terms.gets.length
      ? { label, value: terms.gets.map(leg).join(", "), note: worth(terms.gets) }
      : null;
  if ((terms.layout === "buy" || terms.layout === "sell") && sent && got) {
    const buys = terms.layout === "buy";
    const name = buys ? (got.name ?? got.symbol) : (sent.name ?? sent.symbol);
    return {
      title: `${buys ? "Buy" : "Sell"} ${name}`,
      note: buys ? "to spend" : "to sell",
      action: act(buys ? "Buy" : "Sell"),
      working: `${buys ? "Buying" : "Selling"} ${name}`,
      context: onChain,
      figures: figures(
        { label: buys ? "You pay" : "You sell", value: leg(sent) },
        { label: "You get, about", value: leg(got) },
        terms.price ? { label: "Price", value: terms.price } : null,
        terms.vsMarket ? { label: "Vs market", value: terms.vsMarket } : null,
        terms.networkFee ? { label: "Network fee", value: terms.networkFee } : null,
      ),
      finePrint: via,
      price: terms.price,
      receipt: buys
        ? { title: `Bought ${name}`, detail: `About ${leg(got)}`, amount: "spent" }
        : { title: `Sold ${name}`, detail: `About ${leg(got)} back`, amount: null },
    };
  }
  if (terms.layout === "deposit" && sent && got) {
    const title = `Put ${sent.symbol} into ${terms.app}`;
    return {
      title,
      note: "to put in",
      action: act("Put in"),
      working: `Putting ${sent.symbol} into ${terms.app}`,
      context: onChain,
      // Only what the simulation shows: whether it earns or can be taken out is the app's to say.
      figures: figures(sends("You put in"), gets("You get back")),
      finePrint: sentence(safe, fee, via),
      receipt: { title, detail: onChain, amount: "spent" },
    };
  }
  if (terms.layout === "move" && sent && terms.toChain) {
    return {
      title: `Move ${sent.symbol} to ${terms.toChain}`,
      note: "to move",
      action: act("Move"),
      working: `Moving ${sent.symbol} to ${terms.toChain}`,
      context: terms.app,
      figures: figures(sends("You send"), gets("You get here")),
      scene: { kind: "route", from: terms.chain, sends: leg(sent), to: terms.toChain },
      finePrint: sentence("Bridges usually take a few minutes to land.", fee, via),
      // Done here is sent on its way; the other chain has it a few minutes later.
      receipt: {
        title: `Sent ${sent.symbol} to ${terms.toChain}`,
        detail: "Usually lands in a few minutes",
        amount: "spent",
      },
    };
  }
  // Any other move is the agent's own title, with what goes and comes back beside their worth.
  // One that sends with nothing back says where to, or that nothing comes back: it is what the
  // simulation saw, and why a tap can't vouch for it.
  const back = gets("You get") ?? (sent ? sentTo(terms.to) : null);
  const [verb = "", ...rest] = said.summary.split(" ");
  const known = SUMMARY_VERBS[verb];
  const context = `${terms.site ?? terms.app} on ${terms.chain}`;
  return {
    title: said.summary,
    note: `to ${verb.toLowerCase()}`,
    action: known ? act(verb) : "Confirm",
    working: known ? `${known.doing} ${rest.join(" ")}` : "Working on it",
    context,
    figures: figures(sends("You send"), back),
    finePrint: sentence(safe, fee, via),
    receipt: {
      title: known ? [known.past, ...rest].join(" ") : said.summary,
      detail: context,
      amount: said.moves ? "spent" : null,
    },
  };
}

/** The most a card's warning says, and a line's value (see cardFaceSchema). */
const WARNING_MOST = 500;
export const LINE_MOST = 500;

/**
 * A card's warning that says `first` whole, then `rest` as far as a card takes: what core must
 * say (a permission, money gone for good) goes first, so a cut only ever reaches the rest.
 */
export function warnedFirst(first: string | null, rest: string | null | undefined): string | null {
  return sentence(first, rest ?? null)?.slice(0, WARNING_MOST) ?? null;
}

/**
 * What a card's warning says of the lasting permissions a move leaves, in core's words from its
 * effect, or null when it leaves none. An order the owner places (a stop-loss) is one of the
 * move's terms, which its face says itself (see Grant.order), so it is left out here.
 */
function permissionsWarned(effect: Pick<Effect, "grants">): string | null {
  const lets = effect.grants.filter(({ order }) => !order).map(({ lets }) => lets);
  return lets.length > 0 ? permissionsSaid(lets) : null;
}

/**
 * A face that says, first among its warnings, each lasting permission the move leaves behind,
 * whoever wrote it: the permissions a move grants can't depend on its writer remembering them.
 */
export function withPermissions(face: CardFace, effect: Pick<Effect, "grants">): CardFace {
  const said = permissionsWarned(effect);
  return said ? { ...face, warning: warnedFirst(said, face.warning) } : face;
}

/**
 * Why a move gets no card, or null. It measures exactly what a card draws of what the move
 * leaves, each where a card would cut it: the Lets line (every permission and order, which a
 * plain face and a plan show), and the start of the warning, where money it sends for good
 * (`lost`) comes before its permissions (see withLoss in action-card.ts). A card says all a move
 * grants, or there is no card.
 */
export function tooMuchToWarn(effect: Pick<Effect, "grants">, lost: string | null): string | null {
  const line = letsSaid(effect.grants);
  if (!line) return null;
  const warned = sentence(lost, permissionsWarned(effect)) ?? "";
  return line.length > LINE_MOST || warned.length > WARNING_MOST
    ? `It leaves ${effect.grants.length} permissions${lost ? " and sends money where it is gone for good" : ""}, more than one card can show whole, so no card was made. Each transaction can leave fewer.`
    : null;
}

/** What a move's row recorded of the card it was allowed on. */
type OldCard = Pick<ActionRow, "lines" | "card" | "cardFormat" | "tool" | "proposalId">;

/**
 * Whether a card drawn before cards said all they say now (CARD_FORMAT) left out a lasting
 * permission one of its moves leaves, as its recorded Lets line names them, so the owner allowed
 * it unseen: a plan's card drew no move's Lets line, and a lone move's card drew it only when core
 * drew its face from its lines, or the move's own words warned of it whole. An old row doesn't
 * mark which of what it lets is an order its face showed among its terms (Grant.order), so each
 * counts as a permission.
 */
export function leftOutPermission(legs: readonly OldCard[]): boolean {
  return legs.some((leg) => {
    const lets = leg.lines.find(({ label }) => label === LETS_LINE)?.value;
    if (!lets || leg.cardFormat >= CARD_FORMAT || isAsk(leg.tool)) return false;
    return leg.proposalId !== null || (leg.card !== null && !leg.card.warning?.includes(lets));
  });
}

/** What the plain face reads of a card: core's sentence, its lines, and its money as the card carries it. */
type PlainCard = Pick<ActionCardWire, "summary" | "lines" | "amount" | "flow">;

/**
 * The plain face, for a move that writes none of its own: core's sentence, and the lines core
 * wrote from the move's effect, in its order: what it gives, gets, costs and lets, each whole,
 * since what a transaction sends, and where, is never hidden. It is made where a card is built,
 * from the card as it stands, so it says where money landed (`lands`, from its run) once core
 * knows.
 */
export function plainFace(card: PlainCard, lands: string | null = null): CardFace {
  const moves = card.amount.baseUnits !== "0";
  // Money coming back (a close) is what the move returns, never what it acts on: "Close", not "Close $41".
  const actsOn = moves && card.flow !== "back";
  const [verb = "", ...rest] = card.summary.split(" ");
  const known = SUMMARY_VERBS[verb];
  // Core's sentence may say the dollars itself ("Put $10.00 into savings"); the receipt says them once.
  const said = card.summary.includes(
    formatExactUsd(card.amount.baseUnits, card.amount.currency.decimals),
  );
  return {
    title: card.summary,
    action: known ? (actsOn ? `${verb} ${AMOUNT}` : verb) : "Confirm",
    working: known ? `${known.doing} ${actsOn ? AMOUNT : rest.join(" ")}` : "Working on it",
    context: null,
    figures: card.lines.length
      ? card.lines.map(({ label, value }) => ({ label, value }))
      : figures(moves ? { label: "Amount", value: AMOUNT } : null),
    finePrint: null,
    receipt: {
      title: known ? [known.past, ...rest].join(" ") : card.summary,
      // Where the money is now, when core said; the amount only when the title doesn't.
      detail: lands ? `Arrives as ${lands}` : null,
      // What came back is said once there is any (see fillFace), so a sale says it when it fills.
      amount: card.flow === "back" ? "back" : !moves ? null : said ? null : "spent",
    },
  };
}

const cut = (text: string, most: number) =>
  text.length > most ? `${text.slice(0, most - 1)}…` : text;
const cutOr = <Absent extends null | undefined>(text: string | Absent, most: number) =>
  typeof text === "string" ? cut(text, most) : text;

/**
 * A face cut to the lengths a card takes (see cardFaceSchema), so words that came from outside
 * (a market's question, a token's name, the agent's sentence) can never make a card that fails
 * to draw. Nothing is dropped but the tail of a line too long to read.
 */
export function fitted(face: CardFace): CardFace {
  const { note, logo, scene, warning, price, pick, checks } = face;
  return {
    title: cut(face.title, 500),
    ...(note === undefined ? {} : { note: cut(note, 40) }),
    action: cut(face.action, 120),
    working: cut(face.working, 500),
    context: cutOr(face.context, 500),
    figures: face.figures.map((figure) => ({
      label: cut(figure.label, 60),
      value: cut(figure.value, LINE_MOST),
      ...(figure.note === undefined ? {} : { note: cutOr(figure.note, 40) }),
    })),
    ...(scene
      ? {
          scene: {
            kind: scene.kind,
            from: cut(scene.from, 40),
            sends: cut(scene.sends, 120),
            to: cut(scene.to, 40),
          },
        }
      : {}),
    ...(logo ? { logo } : {}),
    finePrint: cutOr(face.finePrint, 500),
    ...(warning === undefined ? {} : { warning: cutOr(warning, 500) }),
    ...(checks
      ? {
          checks: {
            checked: cut(checks.checked, 80),
            unchecked: checks.unchecked && {
              heading: cut(checks.unchecked.heading, 80),
              says: cut(checks.unchecked.says, 160),
            },
            why: cut(checks.why, 200),
          },
        }
      : {}),
    ...(price === undefined ? {} : { price: cutOr(price, 40) }),
    ...(pick
      ? {
          pick: {
            name: cut(pick.name, 500),
            tag: cutOr(pick.tag, 40),
            ...(pick.verbs ? { verbs: pick.verbs } : {}),
          },
        }
      : {}),
    receipt: {
      title: cut(face.receipt.title, 500),
      detail: cutOr(face.receipt.detail, 500),
      amount: face.receipt.amount,
    },
  };
}
