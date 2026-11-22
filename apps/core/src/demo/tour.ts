import { and, desc, ilike, isNull } from "drizzle-orm";

import type { BrainEvent } from "../apps/contract.ts";
import { db } from "../db/client.ts";
import { threads } from "../db/schema.ts";
import { wakeThread } from "../jobs/kinds.ts";
import type { Stage } from "./brain.ts";

// The tour: a walk through everything Auni does, in about ten minutes, which a person follows by
// tapping. It is a chat like any other. A new chat's first starting point starts it; at each
// stop the demo's brain says what to do and what to notice, as Auni says anything, and docks the
// reply that does it above the box (Auni's own suggest_replies, offered with no question), so
// the next thing is always one tap away. What the tap says is what an owner would type, so the
// scene it plays is the real one (scenes.ts): the tour only adds its words around it.
//
// Where a thread stands on the tour is read from the thread itself: the last "Stop 3 of 13" the
// brain said there. So the tour keeps nothing of its own, a person can walk off and come back,
// and a second tour starts from its first stop.
//
// A stop is one thing to do, said in two or three short sentences, in Auni's own voice ("I").
// A place to go is a link in the words, never a list of taps to remember. To add a stop: add it
// to STOPS, with the scene its reply plays in scenes.ts.

/** Plays the scene for what a stage heard: whether it played to its end (brain.ts). */
type Play = (stage: Stage) => AsyncGenerator<BrainEvent, boolean>;

/** A beat that follows the stop's own reply, as a tap on it says it. */
const REPLY = "reply";

/** Something the tour waits for at a stop, and what it does once the scene for it has played. */
interface Beat {
  /** The stop's reply, or the event core woke the thread with. */
  readonly hears: typeof REPLY | RegExp;
  /** What to notice, said after the scene. */
  readonly notice?: string;
  /** Whether the tour then goes on to the next stop. */
  readonly on?: true;
  /** Whether it goes on as a skip does: this stop came to nothing, and so do those after it. */
  readonly past?: true;
}

interface Stop {
  readonly title: string;
  /** What to do here, said on arriving. */
  readonly does: string;
  /** The reply that does it: what the owner would say, or what they saw where the stop sent them. */
  readonly reply?: string;
  /** The reply only says they have looked: no scene plays for it, and the tour goes on. */
  readonly looked?: true;
  /** Said in a thread the tour passes through (a specialist's), not in its own chat. */
  readonly away?: true;
  /** What such a thread is woken with, which starts the tour there at this stop. */
  readonly opens?: RegExp;
  /** Speaks of what the stop before it left on the screen, so a skip of that one passes it too. */
  readonly follows?: true;
  readonly beats?: readonly Beat[];
}

const SKIP = "Skip";

/** What a tour's own chat is started with, and so titled. */
const START = "Take the tour";

/** A new chat's first starting point in the demo: the tour (brain.ts). */
export const TOUR_POINT = {
  statement: "Auni in 10 minutes.",
  action: "Take the tour",
  prompt: START,
  facts: [1],
};

/** What the take the tour starts tells its specialist, so the tour carries on in its thread. */
export const ON_TOUR = "They are on the demo's tour.";

/** An event core wakes a thread with, by words of it. */
const event = (words: string) => new RegExp(`Background event:[^]*${words}`, "u");

/** Where the way back goes in a stop said away from the tour's chat: filled in as it is said. */
const HOME = "{the tour's chat}";

/** The way back from a thread the tour passes through: one tap, to where the next stop waits. */
const BACK = `The next stop is waiting in my own chat: [back to the tour](${HOME}).`;

const STOPS: readonly Stop[] = [
  {
    title: "Say what you believe",
    does: "Everything I do starts from something you believe, said in your own words. Tap the belief below, as Sam might have typed it.",
    reply: "Peptides go mainstream by 2028",
    beats: [{ hears: REPLY, on: true }],
  },
  {
    title: "A first card",
    follows: true,
    does:
      "This card changes me, not your money. It starts a specialist for this one view, with a pot it can never spend past, which asks you before every move. Tap **Start with $1,500**, then **Open**.\n\n" +
      "Before I answered I looked both stocks up and read your cash. Scroll up and tap **Worked for** to see it.",
  },
  {
    title: "The plan card",
    away: true,
    opens: /The owner just started you[^]*on the demo's tour/u,
    does:
      "This page is the specialist's own, and the card is its plan. I can't write a card like this one: it is made from live quotes, and its button is the only thing that sends money.\n\n" +
      "Tap a row to see why it is there. Then tap **Start with $1,350** and watch each row land.",
    beats: [
      {
        hears: event("finished as done"),
        notice:
          "Both buys landed, each held to the price its card showed. Had a price run away first, that buy would have stopped.",
        on: true,
      },
      {
        hears: event("The owner declined"),
        notice: `Nothing was bought, and the specialist's pot is untouched. ${BACK}`,
        past: true,
      },
    ],
  },
  {
    title: "The position",
    away: true,
    does:
      "This page now holds the position: its pot, what it owns and its record, beside this chat or, on a small screen, behind its value at the top. From here the specialist keeps watching the view, and comes back to you with a card when it would change something.\n\n" +
      BACK,
  },
  {
    title: "A watch",
    does: "I can keep an eye on a price while you get on with your day, and speak up when it moves. Ask me to.",
    reply: "Tell me if Solana drops 5%",
    beats: [
      {
        hears: REPLY,
        notice:
          "It is set. This demo's Solana is about to dip, and within twenty seconds I'll speak up here unasked. Nothing to tap: wait for it.",
      },
      {
        hears: event("\\bwatch"),
        notice:
          "Nobody asked me anything just then: the watch woke me. That is all a watch can do. Anything I would do about it still comes to you as a card.",
        on: true,
      },
    ],
  },
  {
    title: "A move that fails",
    does: "Now one move, which this demo makes fail, so you can see what I do when one goes wrong.",
    reply: "Buy $400 of Coinbase",
    beats: [
      { hears: REPLY, notice: "One move, one card. Tap **Buy $400**." },
      {
        hears: event("finished as failed"),
        notice:
          "I ran that buy first, saw it would fail, and never sent it, so your money stayed where it was. Nothing is sent a second time by itself: **Try again** is yours to tap.",
        on: true,
      },
    ],
  },
  {
    title: "Something no app covers",
    does: "I have an app for some services and none for most. Ask for something at one I have none for.",
    reply: "Stake 25 MON with Kintsu",
    beats: [
      {
        hears: REPLY,
        notice:
          "I ran that transaction before showing you anything. Under **Checked by running it first** is what the run did. My own sentence sits apart, under **Not checked**. Tap the card's button to stake.",
      },
      { hears: event("finished as done[^]*No app for Kintsu"), on: true },
    ],
  },
  {
    title: "Asking for an app",
    follows: true,
    does: "The card below asks the person who maintains me for a Kintsu app. It shows every word that would be posted, and leaves unticked what could point at your wallet. I send nothing: **Open on GitHub** opens a page for you to post yourself.",
    reply: "Nothing is sent without me",
    looked: true,
  },
  {
    title: "I offer an app",
    does: "Some apps need a key of your own, and I ask for it at the moment it matters. Ask for a trade on Solana, which this demo has no key for.",
    reply: "Sell $100 of my Solana",
    beats: [
      {
        hears: REPLY,
        notice:
          "Read the line under the field: what you paste there never passes through me. This demo has no Jupiter to reach, so tap **Not now**.",
      },
      // A key pasted after all connects it, which shows as much.
      { hears: event("The owner (declined|saved their)"), on: true },
    ],
  },
  {
    title: "A switch that stays on",
    does: "Every service I act through is under Apps, with what you hold there. Open [Hyperliquid](/app/apps?app=hyperliquid) and tap its switch. Your browser's back button brings you here again.",
    reply: "It wouldn't turn off",
    looked: true,
  },
  {
    title: "A switch that asks first",
    does: "That one stays on because a position is open there, which I must be able to close. Now open [Aave](/app/apps?app=aave) and tap its switch: it says what off would mean before anything changes.",
    reply: "It said what off would mean",
    looked: true,
  },
  {
    title: "Your money",
    does: "Open [Portfolio](/app). One number for everything, wherever it sits. **Needs you** lists every card still waiting for a tap, and the new specialist is there among the others.",
    reply: "I found Peptides there",
    looked: true,
  },
  {
    title: "The look",
    does: "Last one. Open [Settings](/app?settings=appearance) and pick **Dark**, or whichever look you are not in now. It opens over Portfolio, so you see the change at once. Then come back here.",
    reply: "I've picked a look",
    looked: true,
  },
];

/** How the tour's last words begin, which mark a thread as past its last stop. */
const OVER = "That is the tour.";

const WELCOME =
  "Welcome. This is a demo: Sam, the money and my answers are made up, and everything else is the real app, running on your computer. Nothing here can touch real money.\n\n" +
  `The tour has ${STOPS.length} stops and takes about ten minutes. The next step is always one tap, and you can wander off whenever you like: this chat keeps your place.`;

const END =
  `**${OVER}** Everything you tapped ran my real code: the cards, the moves, the portfolio. Only the AI, the wallet and the world outside were stood in for.\n\n` +
  "Thank you for walking it. Poke at anything from here: nothing in this demo can break.";

/** What to try once the tour is over, as replies docked under its last words, and what each is answered. */
const AFTER: readonly { readonly reply: string; readonly says: string }[] = [
  {
    reply: "What is still waiting for me?",
    says: "Every card still waiting for your tap is under **Needs you** on [Portfolio](/app). Open one, read it, and allow it or turn it down: either way you see what a real one does.",
  },
  {
    reply: "Show me a specialist",
    says: "Each has a page of its own, under **Team**. AI buildout is a good first one: it acts on its own within its pot, so its record shows moves nobody had to tap.",
  },
  {
    reply: "How do I run it for real?",
    says: "Stop this demo with Ctrl-C in its terminal, then start Auni itself: `auni`, or `pnpm start` in a clone. First run starts from your own first take. Nothing from this demo carries over.",
  },
];

/** A stop's words, as Auni says anything, under the heading that also marks the thread's place. */
const caption = (number: number, { title, does }: Stop) =>
  `**Stop ${number} of ${STOPS.length}. ${title}**\n\n${does}`;

/**
 * The stop a thread last reached, by the brain's own words in it: null off the tour, and one
 * past the last stop once the tour is over.
 */
function stopOf(before: readonly string[]): number | null {
  const last = [...before.join("\n").matchAll(/Stop (\d+) of \d+\.|That is the tour\./gu)].at(-1);
  if (!last) return null;
  return last[1] ? Number(last[1]) : STOPS.length + 1;
}

/** Whether a thread is on the tour: a scene that hands on to another thread says so there. */
export function touring(stage: Stage): boolean {
  const at = stopOf(stage.before);
  return at !== null && at <= STOPS.length;
}

/** Whether words start a tour, however they are capitalised. */
const starts = (words: string) => words.toLowerCase().startsWith(START.toLowerCase());

/** Whether a thread is the tour's own chat, which began with its start. */
const wasStarted = ([first = ""]: readonly string[]) =>
  first.startsWith("User: ") && starts(first.slice("User: ".length));

/** The reply docked for a stop: its own, or for one that has none, the last one said before it. */
function replyFor(number: number): string {
  for (let stop = number; stop >= 1; stop -= 1) {
    const { reply } = STOPS[stop - 1]!;
    if (reply) return reply;
  }
  return SKIP;
}

/** Docks replies above the box with no question over them: the first is the one to tap. */
async function* offer(stage: Stage, replies: readonly string[]): AsyncGenerator<BrainEvent, void> {
  yield* stage.call("suggest_replies", { options: replies.map((label) => ({ label })) });
}

/** Docks a stop's reply, with a way past it. */
const dock = (stage: Stage, number: number) => offer(stage, [replyFor(number), SKIP]);

/** The tour's own chat: the newest that began with its start. */
async function home(): Promise<string | undefined> {
  const [found] = await db
    .select({ id: threads.id })
    .from(threads)
    .where(and(ilike(threads.title, `${START}%`), isNull(threads.specialistId)))
    .orderBy(desc(threads.updatedAt))
    .limit(1);
  return found?.id;
}

/** Wakes the tour's chat, so it says the stop the tour has reached somewhere else. */
async function goHome(number: number): Promise<void> {
  const chat = await home();
  if (chat) await wakeThread(chat, `The demo's tour carries on at stop ${number}.`);
}

/** Words as they are said: the way back to the tour's own chat given that chat's address. */
async function placed(words: string): Promise<string> {
  if (!words.includes(HOME)) return words;
  const chat = await home();
  return words.replaceAll(HOME, chat ? `/app/chat/${chat}` : "/app");
}

/**
 * The stop a skip of this one leads to: the next said in the tour's chat that needs nothing a
 * stop before it left on the screen, or one past the last.
 */
function pastStop(at: number): number {
  const next = STOPS.findIndex(({ away, follows }, index) => index >= at && !away && !follows);
  return next < 0 ? STOPS.length + 1 : next + 1;
}

/** Ends the tour: its last words, with what to try next docked under them. */
async function* end(stage: Stage): AsyncGenerator<BrainEvent> {
  yield* offer(
    stage,
    AFTER.map(({ reply }) => reply),
  );
  yield* stage.say(END);
}

/** Says a stop, and docks its reply where the tour's own chat is the one hearing it. */
async function* arrive(stage: Stage, number: number, isHome: boolean): AsyncGenerator<BrainEvent> {
  const stop = STOPS[number - 1];
  // A stop of the tour's own chat, reached in a thread it passes through, is said back there.
  if (!isHome && !stop?.away) return void (await goHome(number));
  if (!stop) return yield* end(stage);
  if (isHome && stop.reply) yield* dock(stage, number);
  yield* stage.say(await placed(caption(number, stop)));
  // The last stop said in a thread the tour passes through: the rest are back in its chat.
  if (!isHome && !STOPS[number]?.away) await goHome(number + 1);
}

/**
 * Plays a turn: the scene for what was heard, and around it the tour's words where the thread is
 * on the tour. Off the tour it is the scene alone.
 */
export async function* tour(stage: Stage, scene: Play): AsyncGenerator<BrainEvent, void> {
  const { heard, before } = stage;
  if (before.length === 0 && starts(heard)) {
    yield* stage.say(WELCOME);
    return yield* arrive(stage, 1, true);
  }
  const carriesOn = /The demo's tour carries on at stop (\d+)/u.exec(heard);
  if (carriesOn) return yield* arrive(stage, Number(carriesOn[1]), true);
  const opened = STOPS.findIndex(({ opens }) => opens?.test(heard));
  if (opened >= 0) {
    if (yield* scene(stage)) yield* arrive(stage, opened + 1, false);
    return;
  }

  const at = stopOf(before);
  if (at === null) return void (yield* scene(stage));
  const isHome = wasStarted(before);
  if (at > STOPS.length) {
    // Over, its chat is a chat like any other, but for the things its last words offered.
    const next = isHome ? AFTER.find(({ reply }) => reply === heard) : undefined;
    if (!next) return void (yield* scene(stage));
    // Docked again are those not yet asked, so the one to tap is never the one just answered.
    const asked = (reply: string) =>
      reply === heard || before.some((block) => block.startsWith(`User: ${reply}`));
    const left = AFTER.filter(({ reply }) => !asked(reply)).map(({ reply }) => reply);
    if (left.length > 0) yield* offer(stage, left);
    return yield* stage.say(next.says);
  }
  const stop = STOPS[at - 1]!;
  // A tap that says they have looked goes on to the next stop. A skip also passes the stops
  // that follow from this one.
  if (isHome && stop.looked && heard === stop.reply) return yield* arrive(stage, at + 1, true);
  if (isHome && /^(skip|next)\b/iu.test(heard)) return yield* arrive(stage, pastStop(at), true);
  // A scene a tool cut short has shown nothing for the tour to speak of.
  const played = yield* scene(stage);
  const beat = played
    ? stop.beats?.find(({ hears }) => (hears === REPLY ? heard === stop.reply : hears.test(heard)))
    : undefined;
  if (beat?.notice) yield* stage.say(await placed(beat.notice));
  if (beat?.on) yield* arrive(stage, at + 1, isHome);
  else if (beat?.past) yield* arrive(stage, pastStop(at), isHome);
  // Anything else said in the tour's chat is answered, and the stop's reply docked again.
  else if (!beat && isHome) yield* dock(stage, at);
}
