import { AMOUNT, type CardFace } from "@auni/shared";

import { figures } from "../../money/card-face.ts";
import about from "./about.ts";

// How Aave's two cards read. The plain face cut the one thing a saver weighs, the rate, short at
// the end of its "You get" line; here it is a figure of its own. Neither types the card's own
// amount: each says AMOUNT.

/** What a supply's card says: cash going into savings on `chain`, earning `rate` ("4.18") now. */
export function supplyFace(chain: string, rate: string | null): CardFace {
  return {
    title: `Save on ${about.name}`,
    note: "to save",
    action: `Save ${AMOUNT}`,
    working: `Putting it into savings on ${about.name}`,
    context: `From your wallet on ${chain}`,
    figures: figures({ label: "Earning now", value: rate ? `${rate}% a year` : "" }),
    finePrint: `${rate ? "The rate moves with how much of the market is lent out. " : ""}Savings count as your cash, a dollar each.`,
    receipt: { title: `Saved on ${about.name}`, detail: `On ${chain}`, amount: "spent" },
  };
}

/** What a withdrawal's card says: savings on `chain` coming back to the wallet there as cash. */
export function withdrawFace(chain: string): CardFace {
  return {
    title: `Take out of savings on ${about.name}`,
    note: "to take out",
    action: `Take out ${AMOUNT}`,
    working: "Taking it out of savings",
    context: `To your wallet on ${chain}`,
    figures: figures({ label: "Arrives", value: "At once, as cash" }),
    finePrint: "Asking for all of it takes the interest earned up to now too.",
    receipt: {
      title: `Took out of savings on ${about.name}`,
      detail: `On ${chain}`,
      amount: "back",
    },
  };
}
