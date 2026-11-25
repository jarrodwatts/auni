import { setTimeout as sleep } from "node:timers/promises";

import { NETWORKS } from "@auni/shared";
import { encodeFunctionData, erc20Abi, getAddress, parseEther } from "viem";

import type { BrainEvent } from "../apps/contract.ts";
import { theOwner } from "../auth/owner.ts";
import type { Stage } from "./brain.ts";
import { payIn } from "./owner.ts";
import { WALLET } from "./wallet.ts";
import { addressOf } from "./world/chain.ts";
import { dip, fireStop } from "./world/hyperliquid.ts";
import { stakeMon, unstakeMon } from "./world/kintsu.ts";
import { failNextSwap, kyberSwap } from "./world/kyberswap.ts";
import { dropNextOrder, FED_MARKET, inAustralia } from "./world/polymarket.ts";

// What the demo's brain does with each thing it hears. A scene is a script: what it thinks, what
// it says, and which of Auni's real tools it calls, in order. The tools run in core as they do
// for a real brain, so each card a scene shows is one core made, priced and sealed. A scene
// plays when what woke the turn matches its `hears`: the owner's own words, its short name typed
// as "demo: <name>", or the background event core woke the thread with.
//
// To add one: write what it hears and what it plays here. If the owner's past should hold it
// too, say its words at some point in the story (seed.ts).

type Play = (stage: Stage) => AsyncGenerator<BrainEvent, void>;

interface Scene {
  /** Its short name: typing "demo: <name>" plays it. */
  readonly name: string;
  /** What it shows, for the list the brain gives when asked; null for one only an event plays. */
  readonly shows: string | null;
  /** What the owner says, or the event core reports, that plays it. */
  readonly hears: RegExp;
  readonly play: Play;
}

/**
 * A moment on the owner's own clock, "2026-11-21 17:00:08", as a clock watch takes it: in their
 * time zone as their settings have it, which the browser they open the demo in sets.
 */
async function onTheirClock(instant: number): Promise<string> {
  const { timeZone } = await theOwner();
  return new Date(instant).toLocaleString("sv-SE", { timeZone });
}

/** Someone else's wallet, made up, that the owner sends to. */
const FRIEND = getAddress("0x97c5e2b14d8a6f3c0e9b7a51d2c4f86e3a1d0b91");
/** The address money is sent to on purpose to burn it. */
const BURN = getAddress("0x000000000000000000000000000000000000dead");

/** The card a money tool made, by the id its answer gives it. */
function cardIn(answer: string): string {
  const card = /\((?:action|proposal) ([0-9a-f-]{36})\)/u.exec(answer)?.[1];
  if (!card) throw new Error(`The demo's brain found no card in: ${answer.slice(0, 200)}`);
  return card;
}

const nvidiaBuy = { stock: "NVDA", side: "buy", amountUsd: 120 };
const teslaBuy = { stock: "TSLA", side: "buy", amountUsd: 80 };

/** How long after a first take's card the demo's money arrives, as if the owner sent it. */
const FIRST_MONEY_MS = 20_000;

/**
 * A new owner's first take, peptides: looked into, then its first picks on one card with $50
 * behind them, the take started behind it; the money arrives while its Add money is open.
 */
const firstTake: Play = async function* ({ think, say, call }) {
  yield* think(
    "A view with years to run. Eli Lilly and Novo Nordisk make most of these drugs, and both trade as stocks on Monad. They're new, so $50 to start, more of it on the leader.",
  );
  yield* call("find_instruments", {
    query: "weight loss drugs",
    related: ["Eli Lilly", "Novo Nordisk"],
  });
  yield* say(
    "Early but right, I think: these drugs already sell about $50 billion a year and demand still outruns supply.\n\nSo here's your take: the two companies that make nearly all of them, more on the leader.",
  );
  yield* call("propose_actions", {
    title: "Peptides go mainstream by 2028",
    legs: [
      {
        tool: "stock_trade",
        input: { stock: "LLY", side: "buy", amountUsd: 30 },
        name: "Eli Lilly",
        why: "Makes the drugs leading the field",
        note: "The clearest way to own the view. If a rival's pill tests better, I'd trim it.",
      },
      {
        tool: "stock_trade",
        input: { stock: "NVO", side: "buy", amountUsd: 20 },
        name: "Novo Nordisk",
        why: "The cheaper of the two big makers",
        note: "A smaller leg on the one playing catch-up. If it keeps losing share, it goes.",
      },
    ],
  });
  // The owner "sends" it from an exchange while the card's Add money is open.
  later(FIRST_MONEY_MS, () => payIn("monad", 60));
};

/** What happens in the demo's world a moment after a scene, as the world does things by itself. */
function later(ms: number, happens: () => void): void {
  setTimeout(happens, ms).unref();
}

const SCENES: readonly Scene[] = [
  // What core wakes a thread with, before anything the owner might say.
  {
    name: "no-app",
    shows: null,
    hears: /finished as done[^]*No app for Kintsu yet/u,
    async *play({ say, call }) {
      yield* say(
        "That worked, but I had to build it by hand. If you'd like Kintsu to work first time here, this asks for an app for it.",
      );
      yield* call("send_feedback", {
        kind: "app",
        about: "Kintsu",
        site: "kintsu.xyz",
        says: "Stake MON with Kintsu and see what it earns.",
      });
    },
  },
  {
    name: "held-told",
    shows: null,
    hears: /\) is held\. /u,
    async *play({ think, say, call }) {
      yield* think(
        "No reply came back from Polymarket, so I can't tell if it filled. I won't send it again. I'll check their live Polymarket shares before saying anything.",
      );
      yield* call("get_portfolio", {});
      yield* say(
        "Polymarket still shows all of your Yes shares, so that order most likely never went in. If you still want to sell, close that card and I'll put the sale up again.",
      );
    },
  },
  {
    name: "closed",
    shows: null,
    hears: /finished as (done|failed): You closed it/u,
    async *play({ say }) {
      yield* say(
        "Closed. Your Fed position is as it was, so that order never went in. Say the word and I'll put the sale up again.",
      );
    },
  },
  {
    // A card shows how its move ended, in place, so a move that went as asked needs no words:
    // a real agent calls settle_quietly, and the demo's says nothing, which leaves the same, no
    // answer at all. One that failed gets Auni's read of why, and what would work.
    name: "settled",
    shows: null,
    hears: /finished as (done|failed|cancelled)|has settled|The owner declined/u,
    async *play({ heard, say }) {
      if (!/finished as failed/u.test(heard)) return;
      yield* say(
        "That route turned the trade down, which usually clears quickly. Tap Try again in a minute, or say the word and I'll look for another route.",
      );
    },
  },
  {
    name: "connected",
    shows: null,
    hears: /The owner allowed your card: (.+?) (is connected|has what it needs)/u,
    async *play({ heard, say }) {
      const [, app] = /allowed your card: (.+?) (?:is connected|has what it needs)/u.exec(heard)!;
      yield* say(
        `${app} is connected, and from now on I can use it whenever it helps. In a real Auni I'd carry straight on with what you asked. This demo has no ${app} to read, so this is where it stops.`,
      );
    },
  },
  {
    name: "arrived",
    shows: null,
    hears: /Background event:[^]*\barrived\b/u,
    async *play({ say }) {
      yield* say("Your money is in. It's sitting as cash until you tell me what to do with it.");
    },
  },
  {
    name: "stopped-out",
    shows: null,
    hears: /stop-loss|closed your/iu,
    async *play({ say }) {
      yield* say(
        "Your stop did its job: the short is closed and the loss is the one you agreed to risk. I'd wait for a cleaner setup before going again.",
      );
    },
  },
  {
    name: "watch-fired",
    shows: null,
    hears: /Background event:[^]*\bwatch\b/iu,
    async *play({ heard, say }) {
      yield* say(
        /friday-check/u.test(heard)
          ? "It's Friday at 5pm, time for the week's check. Your positions are where they were on Monday, give or take a few dollars, and nothing is waiting on you."
          : /as Clock watches it/u.test(heard)
            ? "It's the time you asked me to remind you: your portfolio is where you left it, and nothing is waiting on you."
            : /Solana/u.test(heard)
              ? "Solana just dropped more than 5% in a few minutes, which is what you asked me to watch for. It came straight back, so I'd leave your Solana as it is."
              : "Bitcoin just crossed the level you asked me to watch. Nothing needs doing yet, but it's worth a look.",
      );
    },
  },

  // What the owner asks for.
  {
    name: "ai-buildout",
    shows: "a belief turned straight into a two-stock plan on one card",
    hears: /AI buildout has years/iu,
    async *play({ think, say, call }) {
      yield* think(
        "Nvidia is the core of the AI buildout and Tesla is the robotics leg. Both trade as stocks on Monad where Sam's cash sits.",
      );
      yield* call("update_thread_notes", {
        notes:
          "Thesis: The AI buildout has years to run. Core in chips (NVDA), smaller leg in robotics (TSLA).\nWatch for: Data centre capex guidance cuts from hyperscalers, or further Optimus timeline slips.",
      });
      yield* say(
        "Chips are the surest part of the buildout, so Nvidia carries most of it. Tesla is the long shot: if robots take off it pays most, and if they don't, it's the smaller loss.",
      );
      yield* call("propose_actions", {
        title: "AI buildout picks",
        legs: [
          {
            tool: "stock_trade",
            input: { stock: "NVDA", side: "buy", amountUsd: 1_800 },
            name: "Nvidia",
            why: "Sells the chips everyone is buying",
            note: "The clearest way to own the buildout. If data centre spending guidance is cut, I'd trim it.",
          },
          {
            tool: "stock_trade",
            input: { stock: "TSLA", side: "buy", amountUsd: 900 },
            name: "Tesla",
            why: "The biggest bet on robots",
            note: "A smaller, riskier leg on robotics. If Optimus slips again, I'd drop it.",
          },
        ],
      });
    },
  },
  {
    name: "take",
    shows: "a view looked into, then its picks on one card right in the same thread",
    hears: /peptides go mainstream/iu,
    async *play(stage) {
      const { think, say, call } = stage;
      // A new owner's first take (`auni demo --first-run`), as core tells the turn it is.
      if (/# Their first take/u.test(stage.context)) return yield* firstTake(stage);
      yield* think(
        "Eli Lilly leads on the newest weight-loss drugs, and Novo Nordisk is the cheaper second leg. I'll check that both trade where Sam's cash is, and how much of that cash is free.",
      );
      yield* call("find_instruments", {
        query: "weight loss drugs",
        related: ["Eli Lilly", "Novo Nordisk"],
      });
      yield* call("get_portfolio", {});
      yield* call("update_thread_notes", {
        notes:
          "Thesis: Peptides go mainstream by 2028. Lead with Eli Lilly, smaller leg in Novo Nordisk.\nWatch for: Oral GLP-1 trial readouts from rivals and quarterly script share.",
      });
      yield* say(
        "Between them, Lilly and Novo make nearly all of these drugs, so owning both covers whichever wins. Lilly gets more because its pipeline leads.",
      );
      yield* call("propose_actions", {
        title: "Peptides go mainstream by 2028",
        legs: [
          {
            tool: "stock_trade",
            input: { stock: "LLY", side: "buy", amountUsd: 900 },
            name: "Eli Lilly",
            why: "Makes the drugs leading the field",
            note: "The clearest way to own the view. If a rival's pill tests better, I'd trim it.",
          },
          {
            tool: "stock_trade",
            input: { stock: "NVO", side: "buy", amountUsd: 450 },
            name: "Novo Nordisk",
            why: "The cheaper of the two big makers",
            note: "A smaller leg on the one playing catch-up. If it keeps losing share, it goes.",
          },
        ],
      });
    },
  },
  {
    name: "idle-cash",
    shows: "idle cash put to work in Aave savings",
    hears: /keep my idle cash/iu,
    async *play({ think, say, call }) {
      yield* think(
        "Most of the cash sits on Monad doing nothing. Aave pays about 4% a year there and it can come back out any time.",
      );
      yield* say(
        "Aave is the simplest home for cash you aren't using: it earns while it waits and comes back out whenever a buy needs it.",
      );
      yield* call("aave_supply", { chain: "monad", amount_usd: "4000" });
    },
  },
  {
    name: "holding",
    shows: "working notes and a price watch for an existing holding",
    hears: /Solana keeps taking share/iu,
    async *play({ say, call }) {
      yield* call("update_thread_notes", {
        notes:
          "Thesis: Solana keeps taking share in consumer apps and DEX volume.\nWatch for: Sharp drawdowns to add, or network congestion eating into usage.",
      });
      yield* call("watch", {
        action: "create",
        source: "prices",
        condition: { market: "SOL", crosses: "below", price: 140 },
        description: "Solana falls below $140",
        note: "Sam holds Solana and wants to know if it dips into an add zone.",
        repeat: "once",
      });
      yield* say("I've saved your Solana take in the notes and set a watch if it dips below $140.");
    },
  },
  {
    name: "plan",
    shows: "a plan: several moves on one card, the first getting the money ready",
    hears: /long bitcoin/iu,
    async *play({ think, say, call }) {
      yield* think(
        "Their cash for this is on Arbitrum, and Hyperliquid trades from its own account. So the card needs two moves: the cash goes in first, then the position opens once it has landed.",
      );
      yield* say(
        "I kept it to $2,000 of your cash, so a bad week for bitcoin can't reach the rest of your money.",
      );
      yield* call("propose_actions", {
        title: "Go long bitcoin at 3x",
        legs: [
          { tool: "hyperliquid_deposit", input: { amountUsd: 2_000 } },
          {
            tool: "hyperliquid_order",
            input: { market: "BTC", side: "long", sizeUsd: 3_000, leverage: 3 },
            note: "A 3x long, which Hyperliquid closes by itself if bitcoin falls about 30%. I'd take some off if it runs 15%.",
          },
        ],
      });
    },
  },
  {
    name: "short",
    shows: "a leveraged position with a stop-loss",
    hears: /short ether/iu,
    async *play({ say, call }) {
      yield* say("Small on purpose: it's there to soften a fall, not to be a bet of its own.");
      yield* call("hyperliquid_order", {
        market: "ETH",
        side: "short",
        sizeUsd: 800,
        leverage: 2,
        stopLoss: 3_600,
      });
    },
  },
  {
    name: "limit",
    shows: "an order that waits on the venue's book for its price",
    hears: /if bitcoin dips/iu,
    async *play({ say, call }) {
      yield* say(
        "If bitcoin dips there you get a better price, and if it doesn't you've lost nothing. Hyperliquid holds the stop, so you're covered even while I'm switched off.",
      );
      yield* call("hyperliquid_order", {
        market: "BTC",
        side: "long",
        sizeUsd: 600,
        leverage: 2,
        orderType: "limit",
        limitPrice: 92_000,
        stopLoss: 88_000,
      });
    },
  },
  {
    name: "cancel",
    shows: "an order still waiting taken back off the book (allow `limit` first)",
    hears: /cancel (my|that|the) (limit )?order/iu,
    async *play({ say, call }) {
      // The lookup says which orders still wait; the first is the one to cancel.
      const open = yield* call("hyperliquid_open_orders", {});
      const [, order] = /"order":\s*"(\d+)"/u.exec(open) ?? [];
      if (!order) {
        yield* say(
          "There is no order waiting on Hyperliquid just now. Type `demo: limit` and allow it, then ask again.",
        );
        return;
      }
      yield* say("This takes the order back off Hyperliquid's book. Nothing is bought or sold.");
      yield* call("hyperliquid_cancel_order", { market: "BTC", order });
    },
  },
  {
    name: "fund",
    shows: "cash moved from the wallet into a venue's account",
    hears: /(more (cash|money) (in|on)|put money into) hyperliquid/iu,
    async *play({ say, call }) {
      yield* say("That gives your Hyperliquid account more cushion for new trades or margin.");
      yield* call("hyperliquid_deposit", { amountUsd: 500 });
    },
  },
  {
    name: "stops",
    shows: "a position's stops changed: a take-profit added to the ether short",
    hears: /take-profit/iu,
    async *play({ say, call }) {
      yield* say("That takes the profit by itself if ether falls that far. Your stop stays put.");
      yield* call("hyperliquid_set_stops", { market: "ETH", takeProfit: 3_050 });
    },
  },
  {
    name: "close",
    shows:
      "a position closed, in part or whole (`take half` closes half; `take a sliver` is too small for Hyperliquid, and refused)",
    hears: /take (half|a sliver)|close (my|every)/iu,
    async *play({ heard, say, call }) {
      const half = /half/iu.test(heard);
      const part = half ? 50 : /sliver/iu.test(heard) ? 0.1 : 100;
      yield* say(
        half
          ? "Taking half off banks some of the gain and leaves the rest running if bitcoin keeps going."
          : "Closing it all takes the leverage off the table entirely, and turns the gain into cash you keep.",
      );
      yield* call("hyperliquid_close", { market: "BTC", percent: part });
    },
  },
  {
    name: "home",
    shows: "a plan of moves alone: cash out of a venue's account, then on to another chain",
    hears: /hyperliquid cash home/iu,
    async *play({ say, call }) {
      yield* say("On Monad it sits with the rest of your cash, ready for your next buy.");
      yield* call("propose_actions", {
        title: "Bring your Hyperliquid cash home to Monad",
        legs: [
          { tool: "hyperliquid_withdraw", input: { amountUsd: 500 } },
          {
            tool: "bridge_usdc",
            input: { from_chain: "arbitrum", to_chain: "monad", amount: "499" },
          },
        ],
      });
    },
  },
  {
    name: "tidy",
    shows:
      "a plan of different moves: savings out, cash brought home, and a sale that waits its turn",
    hears: /tidy up/iu,
    async *play({ say, call }) {
      yield* say("Everything ends up as cash on Monad, in one place, ready for whatever's next.");
      yield* call("propose_actions", {
        title: "Tidy up into cash on Monad",
        legs: [
          { tool: "aave_withdraw", input: { chain: "monad", amount_usd: "1000" } },
          {
            tool: "bridge_usdc",
            input: { from_chain: "arbitrum", to_chain: "monad", amount: "500" },
          },
          {
            tool: "stock_trade",
            input: { stock: "NVDA", side: "sell", shares: 0.5, chain: "monad" },
          },
        ],
      });
    },
  },
  {
    name: "withdraw",
    shows: "cash brought back from a venue's account to the wallet",
    hears: /back from hyperliquid|money out of hyperliquid/iu,
    async *play({ say, call }) {
      yield* say(
        "Cash in your wallet is free for anything, and what stays on Hyperliquid keeps backing your long.",
      );
      yield* call("hyperliquid_withdraw", { amountUsd: 500 });
    },
  },
  {
    name: "save",
    shows: "cash put into savings on Aave",
    hears: /put .*into (savings|aave)/iu,
    async *play({ say, call }) {
      yield* say(
        "That adds to your Aave savings on Monad, so it earns while it waits and comes back out any time.",
      );
      yield* call("aave_supply", { chain: "monad", amount_usd: "500" });
    },
  },
  {
    name: "unsave",
    shows: "savings taken out of Aave",
    hears: /out of (my )?(savings|aave)|in aave back out/iu,
    async *play({ say, call }) {
      yield* say("That brings $1,000 back to cash on Monad, and the rest keeps earning in Aave.");
      yield* call("aave_withdraw", { chain: "monad", amount_usd: "1000" });
    },
  },
  {
    name: "long",
    shows: "a leveraged position opened from cash already at the venue",
    hears: /long on BTC/iu,
    async *play({ say, call }) {
      yield* say(
        "That puts $50 of your Hyperliquid cash behind a 3x long, so it moves like $150 of bitcoin. It sits beside the long you already have.",
      );
      yield* call("hyperliquid_order", { market: "BTC", side: "long", sizeUsd: 150, leverage: 3 });
    },
  },
  {
    name: "funding",
    shows: "a question about a venue answered from a look-up, with no card",
    hears: /funding/iu,
    async *play({ say, call }) {
      yield* call("hyperliquid_markets", { query: "BTC" });
      yield* say(
        "Funding is a small fee longs and shorts pay each other every hour. Right now longs pay 0.00125% an hour on bitcoin, which on your 3x long comes to about 50 cents a day.",
      );
      yield* say(
        "It only matters if you hold for months or the rate jumps, and I'd tell you if it did.",
      );
    },
  },
  {
    name: "rate",
    shows: "what savings pay, said plainly",
    hears: /what does aave pay/iu,
    async *play({ say }) {
      yield* say(
        "About 4.1% a year on cash right now, the same on Monad, Base, Arbitrum and Polygon, and you can take it out any time. Yours is on Monad, where most of your cash already was.",
      );
    },
  },
  {
    name: "bets",
    shows: "what is held at one app, read and said back",
    hears: /how are my (polymarket )?bets/iu,
    async *play({ say, call }) {
      yield* call("get_portfolio", {});
      yield* say(
        "You hold one bet: Yes on the Fed cutting rates in December. What it's worth moves with the odds, and its row in your portfolio shows it as it stands. It settles after the Fed's December meeting.",
      );
    },
  },
  {
    name: "markets",
    shows: "what a venue lists, said plainly where the demo has only one market",
    hears: /biggest markets on polymarket/iu,
    async *play({ say }) {
      yield* say(
        "This demo's Polymarket has one market, \"Will the Fed cut rates in December?\", and you already hold Yes in it. On the real Polymarket I'd read you the busiest markets and their odds.",
      );
    },
  },
  {
    name: "bet",
    shows: "a bet started from what you believe",
    hears: /on a polymarket market/iu,
    async *play({ say }) {
      yield* say(
        'Tell me what you think will happen, in your own words, like "the Fed cuts in December", and I\'ll find the market for it and show you the odds.',
      );
      yield* say(
        "One thing first: buying on Polymarket needs your three builder keys, and its page under Apps has a place for them.",
      );
    },
  },
  {
    name: "gold",
    shows: "a token bought for cash, named as its list names it, through the services it uses",
    hears: /\bgold\b/iu,
    async *play({ heard, think, say, call }) {
      yield* think(
        "Tether Gold on Monad is the simplest way to hold gold here: one token is an ounce, and it trades against USDC.",
      );
      yield* say(
        "Tether Gold is backed by real gold, one token to an ounce, so it's the closest thing here to holding the metal.",
      );
      yield* call("evm_swap", {
        chain: "monad",
        sellToken: "USDC",
        buyToken: addressOf("XAUt0"),
        amountUsd: Number(/\$(\d+)/u.exec(heard)?.[1] ?? 30),
      });
    },
  },
  {
    name: "kyber",
    shows: "a swap built by hand through KyberSwap, which its reader names",
    hears: /through kyberswap/iu,
    async *play({ say, call }) {
      // As the kyberswap skill builds one: an exact approval, then the router's swap.
      const usdc = NETWORKS.monad.usdc;
      const sells = 100_000_000n;
      const swap = kyberSwap("monad", usdc, addressOf("TSLAx"), sells, WALLET.evm);
      yield* say(
        "KyberSwap found the best route for this one. It fails rather than fill if Tesla moves more than 1% first.",
      );
      yield* call("send_evm_transaction", {
        chain: "monad",
        calls: [
          {
            to: usdc,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "approve",
              args: [swap.to, sells],
            }),
          },
          swap,
        ],
        summary: "Buy Tesla with $100 of USDC",
      });
    },
  },
  {
    name: "stake",
    shows: "something no app covers: a transaction Auni builds itself and reads by running it",
    hears: /stake (\d+ )?(of my |more )?MON/iu,
    async *play({ heard, think, say, call }) {
      const mon = Number(/(\d+)/u.exec(heard)?.[1] ?? 100);
      yield* think(
        "I have no app for Kintsu, so there is no tool for this. I can still build the staking call myself, run it first and show exactly what it does.",
      );
      yield* say(
        "I have no app for Kintsu yet, so I built this one myself. Stake only MON you mean to hold for a while.",
      );
      yield* call("send_evm_transaction", {
        chain: "monad",
        calls: [stakeMon(parseEther(String(mon)))],
        summary: `Stake ${mon} MON with Kintsu`,
        app: {
          name: "Kintsu",
          site: "kintsu.xyz",
          verb: "stake",
          note: "sMON earns staking rewards while you hold it. Turning it back into MON takes a few days.",
        },
      });
    },
  },
  {
    name: "unstake",
    shows: "a transaction Auni built that a tap can't vouch for, so its card checks it's the owner",
    hears: /\bunstake/iu,
    async *play({ say, call }) {
      yield* say(
        "This hands 25 sMON back to Kintsu, which pays you MON once the wait is over. Nothing comes back today, so this one checks it's you.",
      );
      yield* call("send_evm_transaction", {
        chain: "monad",
        calls: [unstakeMon(parseEther("25"))],
        summary: "Unstake 25 sMON with Kintsu",
        app: {
          name: "Kintsu",
          site: "kintsu.xyz",
          verb: "unstake",
          note: "Kintsu pays the MON back in a few days.",
        },
      });
    },
  },
  {
    name: "send",
    shows: "a send to someone else's address, built by hand, whose card checks it's the owner",
    hears: /\bsend\b.* to (my new wallet|0x)/iu,
    async *play({ say, call }) {
      // As a real one was built: a token and the chain's coin, to one address, in one batch.
      const usdc = NETWORKS.monad.usdc;
      yield* say(
        "Both sends are on one card. Your new wallet has never had anything from this one, so Auni checks it's you before it goes.",
      );
      yield* call("send_evm_transaction", {
        chain: "monad",
        calls: [
          {
            to: usdc,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [FRIEND, 2_500_000n],
            }),
          },
          { to: FRIEND, value: parseEther("1").toString() },
        ],
        summary: "Send USDC and 1 MON to your new wallet",
      });
    },
  },
  {
    name: "burn",
    shows: "a send to a burn address, whose card says what goes there is gone for good",
    hears: /\bburn\b|0x0+dead\b/iu,
    async *play({ say, call }) {
      // A withdrawal there is refused, and a transaction built by hand says so on its card.
      yield* say(
        "Nobody can ever spend from that address, so this dollar would be gone for good. The card says so, and it waits for you.",
      );
      yield* call("send_evm_transaction", {
        chain: "monad",
        calls: [
          {
            to: NETWORKS.monad.usdc,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: "transfer",
              args: [BURN, 1_000_000n],
            }),
          },
        ],
        summary: "Send 1 USDC to the burn address",
      });
    },
  },
  {
    name: "held",
    shows:
      "a held move: a sale Polymarket never answers, which Auni can't confirm and you can close",
    hears: /take a little off my fed bet|try that sale again/iu,
    async *play({ say, call }) {
      // The demo's Polymarket gives this order no answer (world/polymarket.ts).
      dropNextOrder();
      yield* say("A small trim: most of your bet stays on until December.");
      yield* call("polymarket_order", {
        market: FED_MARKET.conditionId,
        outcome: "Yes",
        side: "sell",
        shares: 40,
      });
    },
  },
  {
    name: "region",
    shows: "a bet Polymarket wouldn't take from where Auni runs, refused before anything moves",
    hears: /put \$?1 (dollar )?on no/iu,
    async *play({ call }) {
      // Polymarket now finds this machine in Australia, where it takes no new bets.
      inAustralia();
      yield* call("polymarket_order", {
        market: FED_MARKET.conditionId,
        outcome: "No",
        side: "buy",
        amountUsd: 1,
      });
    },
  },
  {
    name: "sell",
    shows: "a prediction sold: half of a bet, whose cash stays at Polymarket",
    hears: /fed bet/iu,
    async *play({ say, call }) {
      yield* say(
        "Selling half takes some risk off and leaves the rest riding until the Fed's December meeting.",
      );
      yield* call("polymarket_order", {
        market: FED_MARKET.conditionId,
        outcome: "Yes",
        side: "sell",
        shares: 310,
      });
    },
  },
  {
    name: "watch",
    shows: "a watch: something Auni keeps an eye on for you",
    hears: /tell me if bitcoin/iu,
    async *play({ say, call }) {
      yield* call("watch", {
        action: "create",
        source: "prices",
        condition: { market: "BTC", crosses: "below", price: 90_000 },
        description: "Bitcoin falls below $90,000",
        note: "Sam's long is 3x, so a fall this far is worth a decision before the liquidation price is near.",
        repeat: "once",
      });
      yield* say("I'll watch for that and wake up here the moment it happens.");
    },
  },
  {
    name: "fire",
    shows: "a watch that fires: Solana dips a few seconds on, and Auni speaks up unasked",
    hears: /tell me if solana/iu,
    async *play({ say, call }) {
      yield* call("watch", {
        action: "create",
        source: "prices",
        condition: { market: "SOL", moves: "down", percent: 5, within: "5m" },
        description: "Solana drops 5% within five minutes",
        note: "Sam holds Solana, so a sharp drop is worth a look.",
        repeat: "once",
      });
      // The demo's Solana dips for a moment, once the watch has seen it not dipped: the
      // stream says a price every two seconds.
      later(3_500, () => dip("SOL", 0.07));
      yield* say("I'll watch for that and wake up here the moment it happens.");
    },
  },
  {
    name: "routine",
    shows: "an ask that saves a routine",
    hears: /every friday/iu,
    async *play({ say, call }) {
      yield* call("save_routine", {
        name: "friday-check",
        description: "Load on Fridays, or when Sam asks how the week went.",
        body: "1. Read the portfolio and what changed this week.\n2. Say which holdings moved most, up or down, and why if it is known.\n3. Name anything waiting on Sam, and anything worth trimming.\n4. Keep it to five lines.",
      });
      yield* call("watch", {
        action: "create",
        source: "clock",
        condition: { every: ["fri"], at: "17:00" },
        description: "Every Friday at 5:00 pm: the week's check",
        note: "Sam asked for the week's check every Friday at 5pm: load the friday-check routine and follow it.",
      });
      yield* say(
        "I can keep that as a routine, so I do it the same way every week, and I'll wake up every Friday at 5pm to run it.",
      );
    },
  },
  {
    name: "clock",
    shows: "a watch on the clock: Auni wakes a few seconds on, unasked",
    hears: /remind me in a few seconds/iu,
    async *play({ say, call }) {
      yield* call("watch", {
        action: "create",
        source: "clock",
        condition: { at: await onTheirClock(Date.now() + 8_000) },
        description: "In a few seconds: look at the portfolio",
        note: "Sam asked to be reminded in a few seconds to look over the portfolio.",
      });
      yield* say("I'll wake up here in a few seconds and remind you.");
    },
  },
  {
    name: "pot",
    shows: "an ask that lets this thread act on its own within a dollar budget",
    hears: /act on (its|your) own/iu,
    async *play({ say, call }) {
      yield* say(
        "With that on, I can buy and sell here inside your $4,000 budget without asking each time. I'll still ask for perps, bridges, and withdrawals.",
      );
      yield* call("set_thread_autonomy", { act_mode: "within_limits", budget_usd: 4_000 });
    },
  },
  {
    name: "combine",
    shows: "two cards, then one card for both that takes their place",
    hears: /nvidia and tesla/iu,
    async *play({ think, say, call }) {
      const nvidia = cardIn(yield* call("stock_trade", nvidiaBuy));
      yield* say("Here is the Nvidia buy.");
      // A card made beside one still waiting says what it does to it: [] leaves it there.
      const tesla = cardIn(yield* call("stock_trade", { ...teslaBuy, replaces: [] }));
      yield* say("And the Tesla one.");
      yield* think("Two taps for one idea is one too many. A single card can carry both.");
      yield* say(
        "Simpler: one card for both. It takes the place of the two above, so it's the only one to tap.",
      );
      yield* call("propose_actions", {
        title: "Buy Nvidia and Tesla",
        legs: [
          { tool: "stock_trade", input: nvidiaBuy },
          { tool: "stock_trade", input: teslaBuy },
        ],
        replaces: [nvidia, tesla],
      });
    },
  },
  {
    name: "retract",
    shows: "a card waiting in another chat, taken back by Auni",
    hears: /no longer want the nvidia buy/iu,
    async *play({ context, say, call }) {
      // The turn's context names each card waiting elsewhere by its id.
      const card = /- card ([0-9a-f-]{36})[^\n]*Nvidia/iu.exec(context)?.[1];
      if (!card) {
        yield* say("No Nvidia buy is waiting for you, so there's nothing to take back.");
        return;
      }
      yield* call("retract_cards", { cards: [card] });
      yield* say("Done: I've taken that Nvidia card back, so there's nothing left to tap there.");
    },
  },
  {
    name: "fail",
    shows: "a move that fails once allowed, with Try again",
    hears: /buy.*coinbase/iu,
    async *play({ say, call }) {
      yield* say(
        "Coinbase earns when crypto trading picks up, so it tends to move with the coins you already follow.",
      );
      yield* call("stock_trade", { stock: "COIN", side: "buy", amountUsd: 400 });
      // The demo's market refuses the next trade once, so the tap on this card shows a failure.
      failNextSwap();
    },
  },
  {
    name: "move",
    shows: "a single move: one card, one tap",
    hears: /buy.*nvidia/iu,
    async *play({ say, call }) {
      yield* say(
        "Nvidia is still the cleanest way to own the chip buildout, and $250 keeps it a small bet.",
      );
      yield* call("stock_trade", { stock: "NVDA", side: "buy", amountUsd: 250 });
    },
  },
  {
    name: "proposal",
    shows: "a basket of picks on one card",
    hears: /add (to|something)/iu,
    async *play({ think, say, call }) {
      yield* think(
        "Coinbase earns on crypto volume and Nvidia remains the core infrastructure leg, so adding a bit to both widens the position cleanly.",
      );
      yield* say("Two names I'd add, if you agree.");
      yield* call("propose_actions", {
        title: "Add Coinbase and Nvidia",
        legs: [
          {
            tool: "stock_trade",
            input: { stock: "COIN", side: "buy", amountUsd: 300 },
            name: "Coinbase",
            why: "Where the AI token flow trades",
            note: "A side door into the same story. If volumes fall for a quarter, it goes.",
          },
          {
            tool: "stock_trade",
            input: { stock: "NVDA", side: "buy", amountUsd: 200 },
            name: "Nvidia",
            why: "Adds to the core chip leader",
            note: "Tops up the main position while cash is sitting idle.",
          },
        ],
      });
    },
  },
  {
    name: "deposit",
    shows: "a deposit card, waiting for money (`demo: arrival` then sends some)",
    hears: /send (some|more) money/iu,
    async *play({ say, call }) {
      yield* call("wait_for_deposit", { network: "base" });
      yield* say("Send it to this address on Base. I'll tell you the moment it lands.");
    },
  },
  {
    name: "arrival",
    shows: "money arriving from outside, which core finds within a minute",
    hears: /^$/u,
    async *play({ say }) {
      // The owner "sends" it a moment on; core's own sweep then finds it and tells them.
      later(1_000, () => payIn("base", 750));
      yield* say("In a moment $750 will arrive on Base, as if you had sent it from an exchange.");
    },
  },
  {
    name: "stop",
    shows: "something the venue did by itself: a stop-loss closing a position (within ten minutes)",
    hears: /^$/u,
    async *play({ say }) {
      yield* say(
        fireStop("ETH")
          ? "Hyperliquid has just closed your ether short at its stop. I read that from Hyperliquid's own record the next time I look."
          : "There is no position with a stop to close just now. Type `demo: short` to open one.",
      );
    },
  },
  {
    name: "connect",
    shows: "Auni asking for an app's key, in a private field it never sees",
    hears: /what'?s the story with/iu,
    async *play({ think, say, call }) {
      yield* think(
        "The price I can read myself. What people are saying about it is Elfa's to read, and Elfa has no key here, so I'll answer from the price and offer it.",
      );
      yield* call("find_instruments", { query: "Solana" });
      yield* call("get_portfolio", {});
      yield* say(
        "From the price alone: Solana has drifted a little lower this week, with no single day doing the damage. That usually means people losing interest more than anyone selling in a hurry.",
      );
      yield* call("request_secret", {
        field: "keys:elfa",
        why: "I could show you the week's stories pinned to the price, and who is saying what.",
      });
      yield* say("For the story behind it I'd want Elfa, which reads what people are posting.");
    },
  },
  {
    name: "key",
    shows: "Auni asking for an app's key at the moment a trade needs it",
    hears: /sell .*solana/iu,
    async *play({ think, say, call }) {
      yield* think(
        "Trades on Solana go through Jupiter, and Jupiter has no key here, so I can't quote this one. I'll say so and offer it.",
      );
      yield* call("request_secret", {
        field: "keys:jupiter",
        why: "With it I can make this sale, and any other trade on Solana.",
      });
      yield* say(
        "I can't make that sale yet: trades on Solana go through Jupiter, which needs a free key of your own.",
      );
    },
  },
  {
    name: "switched-off",
    shows:
      "Auni offering to turn back on an app the owner switched off (turn Aave off under Apps first)",
    hears: /savings while aave is off/iu,
    async *play({ say, call }) {
      yield* say(
        "Savings go through Aave, and you turned Aave off, so I haven't put anything in. If you'd like it back, the card turns it on.",
      );
      yield* call("connect_app", {
        app: "aave",
        why: "With Aave on I can put your idle cash into savings, where it earns until you need it.",
      });
    },
  },
  {
    name: "stories",
    shows: null,
    hears: /market stories|talking about \w+ this week|a big story breaks/iu,
    async *play({ say }) {
      yield* say(
        "In a real Auni this is where Elfa comes in: the week's stories pinned to the price, who is saying what, and a word from me when one breaks on something you hold. This demo has no Elfa to read, so there is nothing true I could show you here.",
      );
    },
  },
  {
    name: "bug",
    shows: "a problem written up for Auni's maintainer, which you post yourself on GitHub",
    hears: /tell them (this|it) is broken/iu,
    async *play({ say, call }) {
      yield* say("I've written it up. Nothing is sent unless you post it yourself.");
      yield* call("send_feedback", {
        kind: "bug",
        says: "The Coinbase buy failed in the simulation when it should have filled at the price its card showed.",
      });
    },
  },
  {
    name: "request",
    shows: "asking for an app for a service Auni has none for",
    hears: /can you add ([\w.]+)/iu,
    async *play({ heard, say, call }) {
      const [, service] = /can you add ([\w.]+?)[.?!]*(?:\s|$)/iu.exec(heard) ?? [];
      yield* say(
        "Apps come from the person who maintains Auni, so the way to get one is to ask for it on GitHub. Here is the request, ready for you to post under your own name.",
      );
      yield* call("send_feedback", {
        kind: "app",
        about: service ?? "it",
        says: `Use ${service ?? "it"} from inside Auni.`,
      });
    },
  },
  {
    name: "idea",
    shows: "an idea for Auni, written up for you to post",
    hears: /wish auni could/iu,
    async *play({ say, call }) {
      yield* say("That one is worth passing on. Here it is, ready for you to post.");
      yield* call("send_feedback", {
        kind: "idea",
        says: "A weekly email that summarizes how my portfolio and active takes did.",
      });
    },
  },
  {
    name: "brief",
    shows: "a look at the brief now, which uses nothing up",
    hears: /what would my brief say/iu,
    async *play({ say, call }) {
      yield* call("show_brief", {});
      yield* say(
        "In a real Auni your brief would be written here from that: how your holdings moved since the last one, and anything your watches held for it. A look like this uses nothing up, so your next brief still comes at its usual time.",
      );
    },
  },
  {
    name: "think",
    shows: "a long answer with thinking and a look-up, and no card",
    hears: /how (am i|are we) doing/iu,
    async *play({ think, say, call }) {
      yield* think(
        "They want the short version. The portfolio says what is held now; I'll read it rather than go from memory.",
      );
      yield* call("get_portfolio", {});
      await sleep(200);
      yield* say(
        "You're in good shape. Most of your money is working: Nvidia and Tesla from your AI buildout take, your idle cash earning in Aave, and a bitcoin long open on Hyperliquid.",
      );
      yield* say(
        "Nothing needs you right now. The one thing I'd keep an eye on is the long: it's 3x, so a bad week matters more there than anywhere else.",
      );
    },
  },
];

/** What the brain says when nothing it knows matches: what it is, and what it can show. */
const plain: Play = async function* ({ heard, think, say }) {
  if (heard.startsWith("Nothing new from the owner"))
    console.log(`The demo's brain has no scene for this event: ${heard.slice(0, 300)}`);
  yield* think("This is the demo, so I look for a scene I know how to play.");
  yield* say(
    "This is a demo of Auni, so I answer from a script and no money here is real. For a guided walk through everything, start a new chat and tap Take the tour. Or type one of these to see it:\n\n" +
      SCENES.flatMap(({ name, shows }) => (shows ? [`- \`demo: ${name}\` for ${shows}`] : [])).join(
        "\n",
      ),
  );
};

/** The scene for what woke the turn: one named with "demo: <name>", the first it matches, or `plain`. */
export function sceneFor(heard: string): { readonly name: string; readonly play: Play } {
  const named = /^demo:\s*([\w-]+)/iu.exec(heard)?.[1]?.toLowerCase();
  const scene = named
    ? SCENES.find(({ name }) => name === named)
    : SCENES.find(({ hears }) => hears.test(heard));
  return scene ?? { name: "plain", play: plain };
}
