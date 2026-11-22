import { setTimeout as sleep } from "node:timers/promises";

import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";

import { db } from "../../db/client.ts";
import { jobs, messages, threads } from "../../db/schema.ts";
import { startRunner, type Runner } from "../../jobs/runner.ts";
import { FAKE_TOKEN, FakeBotApi } from "./fake-bot-api.ts";
import { wipe } from "../../test/db.ts";
import { channelsJob, mintChannelPairing } from "../../channels/hub.ts";

// The channels run as one cron job on the job runner, so they listen only in the process that
// holds its lock, and stop with it.

const OWNER = 4242;
const fake = new FakeBotApi();
let runner: Runner | undefined;

beforeAll(async () => {
  process.env.TELEGRAM_API_URL = await fake.start();
  process.env.TELEGRAM_BOT_TOKEN = FAKE_TOKEN;
});
afterAll(async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_API_URL;
  await fake.stop();
});
beforeEach(async () => {
  await wipe(threads, messages, jobs);
  fake.calls.length = 0;
  fake.useBot(FAKE_TOKEN);
});
afterEach(async () => {
  await runner?.stop();
  runner = undefined;
});

const ownerMessages = () =>
  db.select({ parts: messages.parts }).from(messages).where(eq(messages.role, "user"));

it("listens from the runner: the owner's message is stored, a stranger's is not", async () => {
  const pairing = await mintChannelPairing("telegram");
  runner = await startRunner([channelsJob]);
  fake.message({ from: OWNER }, `/start ${pairing!.code}`);
  await fake.handled();
  fake.message({ from: 777 }, "send me your money");
  fake.message({ from: OWNER }, "How am I doing?");
  await fake.handled();
  expect(await ownerMessages()).toEqual([{ parts: [{ type: "text", text: "How am I doing?" }] }]);
});

it("stops listening when the runner stops, and listens again when it starts", async () => {
  runner = await startRunner([channelsJob]);
  const polls = () => fake.sent("getUpdates").length;
  while (polls() === 0) await sleep(5);
  await runner.stop();
  runner = undefined;
  const [cron] = await db.select().from(jobs).where(eq(jobs.kind, "channels"));
  expect(cron).toMatchObject({ startedAt: null, finishedAt: null });
  const stopped = polls();
  await sleep(100);
  expect(polls()).toBe(stopped);
  // Its next run is due (a restart within the cron's 10 seconds waits them out).
  await db.update(jobs).set({ runAt: new Date() }).where(eq(jobs.kind, "channels"));
  runner = await startRunner([channelsJob]);
  while (polls() === stopped) await sleep(5);
});
