import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { and, eq, ne, sql } from "drizzle-orm";

import { startChat } from "../conversation/places.ts";
import { archiveChat, pinChat } from "../conversation/tidy.ts";
import { sendMessage } from "../conversation/send.ts";
import { db } from "../db/client.ts";
import { actions, arrivals, owner, type ThreadRow } from "../db/schema.ts";
import { JOBS_CHANNEL } from "../jobs/queue.ts";
import { accounts } from "../apps/registry.ts";
import { allowAction, allowProposal } from "../money/decide.ts";
import { closeHeld } from "../money/held.ts";
import { readPortfolio } from "../money/portfolio.ts";
import { saveReading } from "../money/readings.ts";
import { recordStatement } from "../money/statements.ts";
import { forgetKept } from "../money/swaps/shared.ts";
import { sweepArrivals } from "../money/sweep.ts";
import { setPace } from "./brain.ts";
import { stopClock } from "./clock.ts";
import { fundWallet, payIn } from "./owner.ts";
import { WALLET } from "./wallet.ts";
import { fireStop } from "./world/hyperliquid.ts";
import { playPricesAt, TODAY } from "./world/prices.ts";

// The demo's owner, made as the demo starts by playing their past through Auni itself: money
// arrives on the demo's chains and core's sweep finds it, the owner's messages go in as any
// message does, the demo's brain answers with Auni's real tools (scenes.ts), and each card is
// allowed through the same door a tap uses. So every row is one the app wrote, in the shape it
// writes today, and a change to a tool, a recipe or a card shows here without this file
// changing. Each step is then dated back to when the story says it happened.

const DAY_MS = 24 * 60 * 60_000;

/**
 * Waits until core has nothing left to do: no job due or running but the loops that never end,
 * and no move still on its way. A move that lands later is checked every ten seconds, which the
 * seed doesn't wait out: it has the check run now.
 */
async function quiet(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (let still = 0; still < 3;) {
    await db.execute(sql`
      update jobs set run_at = now()
      where kind = 'landing' and finished_at is null and started_at is null and run_at > now()`);
    await db.execute(sql`select pg_notify(${JOBS_CHANNEL}, '')`);
    const [busy] = await db.execute<{ count: number }>(sql`
      select (select count(*) from jobs
              where finished_at is null and run_at <= now() + interval '2 seconds'
                and (key is null or key not like 'cron:%'))::int
           + (select count(*) from actions where phase in ('queued', 'sending', 'landing'))::int
             as count`);
    still = busy?.count === 0 ? still + 1 : 0;
    if (Date.now() > deadline) {
      const stuck = await db.execute<{ what: string }>(sql`
        select 'job ' || kind || coalesce(' ' || key, '') as what from jobs
        where finished_at is null and run_at <= now() + interval '2 seconds'
          and (key is null or key not like 'cron:%')
        union all
        select 'move ' || summary from actions where phase in ('queued', 'sending', 'landing')`);
      throw new Error(
        `The demo's seed waited a minute on: ${stuck.map(({ what }) => what).join("; ")}.`,
      );
    }
    await sleep(50);
  }
}

/** The owner says something in a thread, and core does everything that follows from it. */
async function say(thread: ThreadRow, text: string): Promise<void> {
  await sendMessage(thread, { id: randomUUID(), text });
  await quiet();
}

/** The owner taps Allow on every card that waits, as the web app's routes do, until none does. */
async function allowWaiting(): Promise<void> {
  for (;;) {
    const waiting = await db
      .select({ id: actions.id, proposalId: actions.proposalId })
      .from(actions)
      // A card asking for a secret is allowed only by the secret, which no owner here pastes.
      .where(and(eq(actions.status, "awaiting_permission"), ne(actions.tool, "request_secret")));
    if (waiting.length === 0) return;
    // A tap comes a few minutes after the card, and after whatever settled before it.
    await passes(3 * 60_000);
    const proposals = new Set(waiting.flatMap(({ proposalId }) => proposalId ?? []));
    for (const proposalId of proposals) await allowProposal(proposalId);
    for (const { id, proposalId } of waiting) if (!proposalId) await allowAction(id);
    await quiet();
  }
}

/** The owner taps Close on every held move, as the web app's route does, some while after it was held. */
async function closeWhatIsHeld(): Promise<void> {
  const held = await db
    .select({ id: actions.id })
    .from(actions)
    .where(eq(actions.phase, "needs_owner"));
  await passes(40 * 60_000);
  for (const { id } of held) await closeHeld(id);
  await quiet();
}

/**
 * Money reaches the owner's wallet from outside, and core's sweep finds it. A sweep may leave a
 * transfer for its next pass, which would record it in a later step and date it there, so this
 * sweeps until the arrival is recorded.
 */
async function arrives(chain: Parameters<typeof payIn>[0], usd: number): Promise<void> {
  const hash = payIn(chain, usd);
  for (let pass = 1; ; pass += 1) {
    await sweepArrivals(true);
    await quiet();
    const [found] = await db
      .select({ id: arrivals.id })
      .from(arrivals)
      .where(eq(arrivals.txHash, hash));
    if (found) return;
    if (pass === 20) throw new Error(`The demo's sweep never found ${usd} arriving on ${chain}.`);
    await sleep(100);
  }
}

/**
 * Cash a venue pays back to the wallet arrives from outside, in a transaction Auni never sent,
 * so core's sweep is what ties it to the move that asked for it. This sweeps until every such
 * move has its arrival recorded, so the landing is dated in the step that made it.
 */
async function paidBack(): Promise<void> {
  for (let pass = 1; ; pass += 1) {
    await sweepArrivals(true);
    await quiet();
    const [waiting] = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from ${actions}
      where ${actions.run} ? 'landsUnits' and ${actions.status} = 'done'
        and not exists (select 1 from ${arrivals} where ${arrivals.actionId} = ${actions.id})`);
    if (waiting?.count === 0) return;
    if (pass === 20) throw new Error("The demo's sweep never found what a venue paid back.");
    await sleep(100);
  }
}

const HOUR_MS = 60 * 60_000;

// How a step of the owner's past is dated. Core writes each row at the clock's time, and how
// long a step takes to play differs by a little on every run. So once a part of a step has been
// played and core has gone quiet, the moments it wrote are settled: each is moved onto exact
// times, a millisecond apart in the order they were written, and at the step's end they are all
// moved to when the story says the step happened. What the app shows of the past (the minute a
// card was allowed, where a reading sits on a chart) is then the same on every run.

/** Every column that holds a moment, in every table but the job runner's own. */
const momentColumns = lastingly(async () => {
  const columns = await db.execute<{ table: string; column: string }>(sql`
    select table_name as "table", column_name as "column" from information_schema.columns
    where table_schema = 'public' and data_type = 'timestamp with time zone'
      and table_name <> 'jobs'`);
  return columns.map(({ table, column }) => ({
    table: sql.identifier(table),
    column: sql.identifier(column),
  }));
});

function lastingly<T>(read: () => Promise<T>): () => Promise<T> {
  let kept: Promise<T> | undefined;
  return () => (kept ??= read());
}

/** The second before now: a chain dates what it mines to the second, so what is written from here on is no earlier. */
async function secondBefore(): Promise<Date> {
  const [now] = await db.execute<{ now: string }>(
    sql`select (date_trunc('second', now()) - interval '1 second')::text as now`,
  );
  return new Date(now!.now);
}

/** The step being played. */
const playing = {
  /** What is written at or after this moment of the clock is not settled yet. */
  since: new Date(),
  /**
   * The exact times its settled moments lie on, from `from` up to `to`: an hour behind the
   * clock, so none is taken for one still being written.
   */
  from: 0,
  to: 0,
};

/**
 * Settles what the step has written since it last did: each moment goes onto the next exact
 * time after those settled before, as many milliseconds on as moments were written before it,
 * so two written together stay together and the order of the rest is kept.
 */
async function settle(): Promise<void> {
  const columns = await momentColumns();
  const since = sql`${playing.since.toISOString()}::timestamptz`;
  const written = sql.join(
    columns.map(
      ({ table, column }) =>
        sql`select ${column} as written_at from ${table} where ${column} >= ${since}`,
    ),
    sql` union all `,
  );
  const count = await db.transaction(async (tx) => {
    await tx.execute(sql`
      create temp table demo_settled on commit drop as
      select written_at, rank() over (order by written_at) - 1 as before
      from (${written}) written`);
    for (const { table, column } of columns)
      await tx.execute(sql`
        update ${table}
        set ${column} = ${new Date(playing.to).toISOString()}::timestamptz
                        + make_interval(secs => settled.before / 1000.0)
        from (select distinct written_at, before from demo_settled) settled
        where ${table}.${column} = settled.written_at`);
    const [all] = await tx.execute<{ count: number }>(
      sql`select count(*)::int as count from demo_settled`,
    );
    return all!.count;
  });
  playing.to += count;
  playing.since = await secondBefore();
}

/** Moves every settled moment of the step being played `ms` earlier. */
async function earlier(ms: number): Promise<void> {
  const bounds = sql`${new Date(playing.from).toISOString()}::timestamptz
                 and ${new Date(playing.to).toISOString()}::timestamptz`;
  for (const { table, column } of await momentColumns())
    await db.execute(sql`
      update ${table} set ${column} = ${column} - make_interval(secs => ${ms / 1_000})
      where ${column} between ${bounds}`);
  playing.from -= ms;
}

/** Lets `ms` pass in the step being played: all it has written so far happened that much earlier. */
async function passes(ms: number): Promise<void> {
  await settle();
  await earlier(ms);
}

/**
 * One step of the owner's past: what happened, how many days ago and at what time of that day
 * (`clock`, "10:15", on this machine's clock). A fixed time of day, so the times the app shows
 * are the same whenever the demo is run.
 */
async function step(daysAgo: number, clock: string, play: () => Promise<void>): Promise<void> {
  playing.since = await secondBefore();
  const [hours, minutes] = clock.split(":").map(Number);
  const then = new Date(playing.since);
  then.setDate(then.getDate() - daysAgo);
  then.setHours(hours!, minutes!, 0, 0);
  const began = playing.since.getTime() - HOUR_MS;
  playing.from = playing.to = began;
  // At the prices of when it happened, so what it paid is what the charts say things cost then.
  playPricesAt(then.getTime(), playing.since.getTime() - then.getTime());
  // Core keeps what it just read for a few seconds, and a step follows the last within one.
  forgetKept();
  await play();
  await quiet();
  await settle();
  // A reading of the portfolio as it stood then. One is kept only once the moves before it have
  // settled, which they now have for an hour.
  await saveReading(await readPortfolio());
  await settle();
  // The step began at `began` on its exact times, and happened at `then`.
  await earlier(began - then.getTime());
  playPricesAt();
}

/**
 * When the owner's past last left cards for a tap, as a step takes it: the latest of yesterday
 * at 17:30, today at 07:30 and today at 17:30 that was an hour or more ago. So they have waited
 * less than the day a card waits (CARD_WAITS_MS) at whatever hour the demo runs, at one of three
 * fixed times.
 */
function lately(): [daysAgo: number, clock: string] {
  const at = (daysAgo: number, hours: number) => {
    const then = new Date();
    then.setDate(then.getDate() - daysAgo);
    then.setHours(hours, 30, 0, 0);
    return then.getTime();
  };
  if (Date.now() - at(0, 17) >= HOUR_MS) return [0, "17:30"];
  if (Date.now() - at(0, 7) >= HOUR_MS) return [0, "07:30"];
  return [1, "17:30"];
}

/** Makes the demo's owner. Runs once core's jobs and API are up (start.ts). */
export async function seed(): Promise<void> {
  const seedBegan = Date.now();
  setPace(0);
  await db.update(owner).set({
    name: "Sam",
    // This machine's, as the browser that opens the demo here says too: the owner's midnight is
    // the one the demo's prices and past are laid from (world/prices.ts).
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    // The morning of the first step (below).
    welcomedAt: new Date(TODAY - 21 * DAY_MS + 9 * 60 * 60_000),
    backupSavedAt: new Date(TODAY - 21 * DAY_MS + 9 * 60 * 60_000),
  });
  fundWallet();
  // The first sweep of a wallet only marks where it starts: what comes in after is news.
  await sweepArrivals(true);

  // Three weeks ago: the first money, and the first view.
  let aiBuildout!: ThreadRow;
  await step(21, "09:40", async () => {
    await arrives("monad", 12_000);
    aiBuildout = await startChat("AI buildout");
    await say(
      aiBuildout,
      "I think the AI buildout has years to run. Can you run that for me with $3,000?",
    );
    await allowWaiting();
    await pinChat(aiBuildout, true);
  });

  // A leveraged position, paid for with money sent in on another network.
  let trading!: ThreadRow;
  await step(17, "19:05", async () => {
    // More than the long needs, so `demo: plan` can be played again and allowed.
    await arrives("arbitrum", 5_000);
    trading = await startChat("I want to go long bitcoin");
    await say(trading, "I want to go long bitcoin with a bit of leverage.");
    await allowWaiting();
  });

  await step(14, "08:30", async () => {
    const chat = await startChat("Keep my idle cash earning");
    await say(chat, "Can you keep my idle cash earning?");
    await allowWaiting();
  });

  // Watching an existing Solana position in its own thread.
  await step(11, "13:20", async () => {
    const chat = await startChat("Solana");
    await say(chat, "I think Solana keeps taking share. Keep an eye on the Solana I hold.");
    await allowWaiting();
  });

  // Something no app covers: Auni built it by hand, and afterwards offered to ask for an app.
  await step(9, "20:15", async () => {
    const chat = await startChat("Stake 40 of my MON with Kintsu");
    await say(chat, "Stake 40 of my MON with Kintsu.");
    await allowWaiting();
  });

  await step(8, "16:45", async () => {
    await say(trading, "Open a small short ether as a hedge.");
    await allowWaiting();
  });

  // The positions looked after: an exit added to one, part of the other taken off.
  await step(7, "11:10", async () => {
    await say(trading, "Add a take-profit to the ether short.");
    await allowWaiting();
  });

  await step(6, "07:55", async () => {
    await say(trading, "Tell me if bitcoin falls a long way.");
  });

  await step(5, "14:35", async () => {
    await say(trading, "Take half of the bitcoin long off.");
    await allowWaiting();
  });

  await step(4, "18:10", async () => {
    const chat = await startChat("Every Friday, tell me how the week went");
    await say(chat, "Every Friday, tell me how the week went.");
    await allowWaiting();
  });

  await step(3, "12:00", async () => {
    await say(aiBuildout, "You can act on your own now with a $4,000 budget.");
    await allowWaiting();
  });

  // A sale Polymarket never answered: Auni couldn't tell whether it went, said so once, and the
  // owner closed it.
  let trimming!: ThreadRow;
  await step(3, "19:20", async () => {
    trimming = await startChat("Take a little off my Fed bet");
    await say(trimming, "Take a little off my Fed bet.");
    await allowWaiting();
    await closeWhatIsHeld();
  });

  // A move that failed, left as it is so its card shows Try again.
  await step(2, "10:25", async () => {
    const chat = await startChat("Buy $400 of Coinbase");
    await say(chat, "Buy $400 of Coinbase.");
    await allowWaiting();
  });

  // Cash the long freed, brought home from the venue's account.
  await step(2, "15:40", async () => {
    await say(trading, "Bring $500 back from Hyperliquid.");
    await allowWaiting();
    await paidBack();
  });

  // Yesterday the venue acted by itself: the short's stop fired, and Auni read it afterwards.
  await step(1, "09:15", async () => {
    fireStop("ETH");
    for (const { about, account } of accounts())
      if (account.statement) await recordStatement(about.id, account.statement(WALLET.evm));
  });

  // A token that isn't a stock, bought for cash: Activity tells what it paid, got and went through.
  await step(1, "16:30", async () => {
    await say(await startChat("Buy $30 of gold"), "Buy $30 of gold.");
    await allowWaiting();
  });

  // Lately: a question answered, and cards left for a tap, one of them an app offered.
  await step(...lately(), async () => {
    // The same sale tried again and unanswered again: left held, so its card shows Check again
    // and Close. Allowed before the cards below are made, which wait for a tap.
    await say(trimming, "Try that sale again.");
    await allowWaiting();
    // Answered and tidied away: archived, so search finds it and History doesn't list it.
    const asked = await startChat("How am I doing?");
    await say(asked, "How am I doing?");
    await archiveChat(asked, true);
    await say(await startChat("Buy $250 of Nvidia"), "Buy $250 of Nvidia.");
    await say(await startChat("Close my bitcoin long"), "Close my bitcoin long.");
    await say(await startChat("Sell half of my Fed bet"), "Sell half of my Fed bet.");
    await say(await startChat("Stake 60 of my MON with Kintsu"), "Stake 60 of my MON with Kintsu.");
    await say(
      await startChat("What's the story with SOL this week?"),
      "What's the story with SOL this week?",
    );
    await say(await startChat("I'm going to send some money"), "I'm going to send some money in.");
  });
  const tookMs = Date.now() - seedBegan;
  // A demo started at a moment stands still at it from here on, so what it shows of now, today
  // and the past week is the same on every run.
  await stopClock();
  forgetKept();
  await saveReading(await readPortfolio());
  setPace(18);

  const cards = await db
    .select({ status: actions.status, count: sql<number>`count(*)::int` })
    .from(actions)
    .groupBy(actions.status);
  const count = (status: string) => cards.find((card) => card.status === status)?.count ?? 0;
  console.log(
    `The demo's owner is ready (${(tookMs / 1_000).toFixed(1)} s): ` +
      `${count("done")} cards done, ${count("awaiting_permission")} waiting, ` +
      `${count("failed")} failed, ${count("running")} held.`,
  );
}
