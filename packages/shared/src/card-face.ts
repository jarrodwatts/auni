import { z } from "zod";

import { formatExactUsd, type MoneyWire } from "./money.ts";

/**
 * Where a card's amount goes in the words of its face. The dollars are never typed into a face:
 * the code that writes one puts this where the amount belongs ("Buy Yes for {amount}"), and
 * `fillFace` puts in the card's own amount, which core priced. So a face cannot say a different
 * number of dollars from the one core checks a pot and a permission against, and a sale that has
 * filled says what it brought back.
 */
export const AMOUNT = "{amount}";

/**
 * What a money card says, as plain data: its title, its button, its figures and its receipt. One
 * shape says every money card, so the web app and each channel draw any move without knowing
 * which service it runs on, and the words sit with the code that knows what they mean.
 *
 * `title`, `action`, `working` and a figure's `value` may hold `AMOUNT`.
 */
export const cardFaceSchema = z.object({
  /** What the move is: "Long BTC at 5x", "Buy Yes for {amount}". */
  title: z.string().max(500),
  /** Under the amount, what the money is for: "to put in". With it the title is shown whole. */
  note: z.string().max(40).optional(),
  /** The button that allows it, short: "Long BTC", "Buy {amount}". */
  action: z.string().max(120),
  /** What the card says while the move runs: "Opening your long". */
  working: z.string().max(500),
  /** The line under the title: where it runs, or the question it bets on. */
  context: z.string().max(500).nullable(),
  /**
   * The numbers the owner agrees to, in the order they read: a few, for a face a move writes
   * itself. The plain face says every line of the move's effect, however many, since what a
   * transaction does is never hidden. One with no value is left out.
   */
  figures: z.array(
    z.object({
      label: z.string().max(60),
      value: z.string().max(500),
      /** What the value is worth, said small beside it: "$26.04". */
      note: z.string().max(40).nullable().optional(),
    }),
  ),
  /** A small picture of the move. One today: cash leaving one chain and landing on another. */
  scene: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("route"),
        from: z.string().max(40),
        sends: z.string().max(120),
        to: z.string().max(40),
      }),
    ])
    .optional(),
  /**
   * A mark of its own the card wears in place of its subject's: the app a transaction was built
   * for. `name` is whose it is; `src` its logo, or null when it has none, and the card then draws
   * that name's initial. `inset` when the logo is drawn on transparency, so it is set in from the
   * circle's edge.
   */
  logo: z
    .object({
      src: z.string().max(2_000).nullable(),
      inset: z.boolean(),
      name: z.string().max(40),
    })
    .optional(),
  /** One quiet line of what else is true of the move. */
  finePrint: z.string().max(500).nullable(),
  /**
   * The one quiet line of what the card also buys for its network fees, which is no cost. Core
   * writes it from what the card pinned, whatever the move and whoever wrote its face (core's
   * money/fee-coin-said.ts), so no drawing of a card leaves out a send its Allow signs.
   */
  buysFirst: z.string().max(300).optional(),
  /** A permission the move leaves behind, said on its own line in red. */
  warning: z.string().max(500).nullable().optional(),
  /**
   * Set on the card of a transaction the agent built for a service no app covers, which nothing
   * vouches for but its simulation. The card then says apart what Auni checked by running the
   * transaction (its figures, its fine print, its warning) and what nobody checked.
   */
  checks: z
    .object({
      /** The heading over what the simulation showed: "Checked by running it first". */
      checked: z.string().max(80),
      /**
       * The agent's own sentence about the move, under a heading that says nobody checked it.
       * Null when the agent gave none, and always on a card that takes the owner's proof.
       */
      unchecked: z.object({ heading: z.string().max(80), says: z.string().max(160) }).nullable(),
      /** Why the card reads this way: "No app for Lido yet, so Auni read this by running it first." */
      why: z.string().max(200),
    })
    .optional(),
  /** One unit's price as the card says it ("$184.20", "62¢"), which Try again prices afresh. */
  price: z.string().max(40).nullable().optional(),
  /**
   * How the move reads as one row among several on a plan, when its title is not the best name
   * for it there: a bet reads as its market ("Rate cut in December") with its side as a tag.
   */
  pick: z
    .object({
      name: z.string().max(500),
      /** The short word beside the name: "Yes", "5x long". */
      tag: z.string().max(40).nullable(),
      /**
       * What the row says before the name while it runs, once done, and if it did not go
       * through, when buying or selling is the wrong word: "Betting on", "Bet on", "Didn't bet on".
       */
      verbs: z
        .object({ now: z.string().max(40), done: z.string().max(40), failed: z.string().max(40) })
        .optional(),
    })
    .optional(),
  /** What the card says once the move is done. */
  receipt: z.object({
    title: z.string().max(500),
    detail: z.string().max(500).nullable(),
    /**
     * Whether the receipt says the card's amount, and how: `spent` says it plainly ("$50"), and
     * `back` says it came back ("$3.98 back"), or nothing while the amount is zero, since what a
     * sale brings back is only known once it fills.
     */
    amount: z.enum(["spent", "back"]).nullable(),
  }),
});
export type CardFace = z.infer<typeof cardFaceSchema>;

/** A face with the card's amount in place: the words as they are drawn. */
export type FilledFace = Omit<CardFace, "receipt"> & {
  readonly receipt: Omit<CardFace["receipt"], "amount"> & { readonly amount: string | null };
};

/** A face as a card of this `amount` reads: every `AMOUNT` filled in, and the receipt's amount said. */
export function fillFace(face: CardFace, amount: MoneyWire): FilledFace {
  const dollars = formatExactUsd(amount.baseUnits, amount.currency.decimals);
  const filled = (text: string) => text.replaceAll(AMOUNT, dollars);
  const { receipt } = face;
  return {
    ...face,
    title: filled(face.title),
    action: filled(face.action),
    working: filled(face.working),
    figures: face.figures.map((figure) => ({ ...figure, value: filled(figure.value) })),
    receipt: {
      ...receipt,
      amount:
        receipt.amount === "spent"
          ? dollars
          : receipt.amount === "back" && amount.baseUnits !== "0"
            ? `${dollars} back`
            : null,
    },
  };
}

/**
 * The verbs a move's sentence starts with ("Move $30 to Polygon"), and how the move says them
 * while it runs and once done: "Moving", "Moved". A sentence that starts with none of these is
 * said as it is.
 */
export const SUMMARY_VERBS: Readonly<
  Record<string, { readonly doing: string; readonly past: string }>
> = {
  Borrow: { doing: "Borrowing", past: "Borrowed" },
  Bridge: { doing: "Bridging", past: "Bridged" },
  Buy: { doing: "Buying", past: "Bought" },
  Claim: { doing: "Claiming", past: "Claimed" },
  Close: { doing: "Closing", past: "Closed" },
  Collect: { doing: "Collecting", past: "Collected" },
  Deposit: { doing: "Depositing", past: "Deposited" },
  Move: { doing: "Moving", past: "Moved" },
  Put: { doing: "Putting in", past: "Put" },
  Repay: { doing: "Repaying", past: "Repaid" },
  Sell: { doing: "Selling", past: "Sold" },
  Send: { doing: "Sending", past: "Sent" },
  Stake: { doing: "Staking", past: "Staked" },
  Supply: { doing: "Supplying", past: "Supplied" },
  Swap: { doing: "Swapping", past: "Swapped" },
  Unstake: { doing: "Unstaking", past: "Unstaked" },
  Update: { doing: "Updating", past: "Updated" },
  Withdraw: { doing: "Withdrawing", past: "Withdrew" },
};
