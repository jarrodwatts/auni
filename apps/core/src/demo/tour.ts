import type { BrainEvent } from "../apps/contract.ts";
import type { Stage } from "./brain.ts";

// The tour: a walk through everything Auni does, in about ten minutes, which a person follows by
// tapping. It is a chat like any other. A new chat's first starting point starts it; at each
// stop the demo's brain says what to do and what to notice, as Auni says anything, and docks the
// reply that does it above the box (Auni's own suggest_replies, offered with no question), so
// the next thing is always one tap away. What the tap says is what an owner would type, so the
// scene it plays is the real one (scenes.ts): the tour only adds its words around it.
//
// Where a thread stands on the tour is read from the thread itself: the last "Stop 3 of 12" the
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

/** An event core wakes a thread with, by words of it. */
const event = (words: string) => new RegExp(`Background event:[^]*${words}`, "u");

const STOPS: readonly Stop[] = [
  {
    title: "Say what you believe",
    does: "Everything I do starts from something you believe, said in your own words. Tap the belief below, as Sam might have typed it.",
    reply: "Peptides go mainstream by 2028",
    beats: [{ hears: REPLY, on: true }],
  },
  {
    title: "The plan card",
    follows: true,
    does:
      "I can't write a card like this one: it is made from live quotes, and its button is the only thing that sends money. Before answering I looked both stocks up and read your cash. Scroll up and tap **3 steps** to see it.\n\n" +
      "Tap a row to see why it is there. Then tap **Buy both for $1,350** and watch each buy land.",
    beats: [
      {
        hears: event("finished as done"),
        notice:
          "Both buys landed, each held to the price its card showed. Had a price run away first, that buy would have stopped.",
        on: true,
      },
      {
        hears: event("The owner declined"),
        notice: "Nothing was bought, and your cash is untouched.",
        past: true,
      },
    ],
  },
  {
    title: "This thread's panel",
    follows: true,
    does: "Everything tied to this thread sits beside the chat: the positions opened here, its notes, watches, and its record. You can also switch any thread between **Ask first** and **Auto** within a dollar budget from the strip under the box.",
    reply: "I see the panel",
    looked: true,
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
    does: "Open [Money](/app). Your total sits at the top, followed by each take with what it holds and what it has made. Eli Lilly and Novo Nordisk sit under the take that bought them, and every move is saved as a receipt.",
    reply: "I found them there",
    looked: true,
  },
  {
    title: "The look",
    does: "Last one. Open [Settings](/app?settings=appearance) and pick **Dark**, or whichever look you are not in now. It opens over Money, so you see the change at once. Then come back here.",
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
  `**${OVER}** Everything you tapped ran my real code: the cards, the moves, your money. Only the AI, the wallet and the world outside were stood in for.\n\n` +
  "Thank you for walking it. Poke at anything from here: nothing in this demo can break.";

/** What to try once the tour is over, as replies docked under its last words, and what each is answered. */
const AFTER: readonly { readonly reply: string; readonly says: string }[] = [
  {
    reply: "What is still waiting for me?",
    says: "Every card still waiting for your tap is under **Needs you**. Open one, read it, and allow or decline it. Either way, you'll see what a real one does.",
  },
  {
    reply: "Show me an Auto thread",
    says: "Open **AI buildout** in the sidebar. It is set to act on its own within a $4,000 budget, with its positions, notes and budget bar right in the panel beside the chat.",
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

/**
 * The stop a skip of this one leads to: the next that needs nothing a
 * stop before it left on the screen, or one past the last.
 */
function pastStop(at: number): number {
  const next = STOPS.findIndex(({ follows }, index) => index >= at && !follows);
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

/** Says a stop, and docks its reply when it has one. */
async function* arrive(stage: Stage, number: number): AsyncGenerator<BrainEvent> {
  const stop = STOPS[number - 1];
  if (!stop) return yield* end(stage);
  if (stop.reply) yield* dock(stage, number);
  yield* stage.say(caption(number, stop));
}

/**
 * Plays a turn: the scene for what was heard, and around it the tour's words where the thread is
 * on the tour. Off the tour it is the scene alone.
 */
export async function* tour(stage: Stage, scene: Play): AsyncGenerator<BrainEvent, void> {
  const { heard, before } = stage;
  if (before.length === 0 && starts(heard)) {
    yield* stage.say(WELCOME);
    return yield* arrive(stage, 1);
  }

  const at = stopOf(before);
  if (at === null || !wasStarted(before)) return void (yield* scene(stage));
  if (at > STOPS.length) {
    // Over, its chat is a chat like any other, but for the things its last words offered.
    const next = AFTER.find(({ reply }) => reply === heard);
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
  if (stop.looked && heard === stop.reply) return yield* arrive(stage, at + 1);
  if (/^(skip|next)\b/iu.test(heard)) return yield* arrive(stage, pastStop(at));
  // A scene a tool cut short has shown nothing for the tour to speak of.
  const played = yield* scene(stage);
  const beat = played
    ? stop.beats?.find(({ hears }) => (hears === REPLY ? heard === stop.reply : hears.test(heard)))
    : undefined;
  if (beat?.notice) yield* stage.say(beat.notice);
  if (beat?.on) yield* arrive(stage, at + 1);
  else if (beat?.past) yield* arrive(stage, pastStop(at));
  // Anything else said in the tour's chat is answered, and the stop's reply docked again.
  else if (!beat) yield* dock(stage, at);
}
