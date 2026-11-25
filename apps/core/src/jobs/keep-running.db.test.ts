import { setTimeout as sleep } from "node:timers/promises";

import type { AppAbout } from "@auni/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tempDir } from "../test/temp-dir.ts";
import { sourcesJob } from "../automations/sources.ts";
import { channelsJob, listenOnChannels } from "../channels/hub.ts";
import { saveSetting, saveSwitch } from "../settings.ts";
import { startRunner, type Runner } from "./runner.ts";

// The two loops that live as long as Auni (the channels listening, the watch sources running)
// read their settings once as they start. So a setting saved from the app ends each, and its job
// runs again at once with what was saved: no restart, and never two listeners on one bot.

// What the mock below is made from is hoisted with it, above this file's imports.
const { CHAT, NEWS, TICKS, started, begin } = vi.hoisted(() => {
  /** Each time a loop started: who started, with which setting, and the signal that ends it. */
  const started: { readonly who: string; readonly with: string; readonly signal: AbortSignal }[] =
    [];
  return {
    CHAT: {
      id: "fake-chat",
      name: "Fake Chat",
      settings: { token: { env: "FAKE_CHAT_TOKEN", label: "Bot token", kind: "secret" } },
    } as const satisfies AppAbout,
    NEWS: {
      id: "fake-news",
      name: "Fake News",
      settings: { key: { env: "FAKE_NEWS_KEY", label: "API key", kind: "secret" } },
    } as const satisfies AppAbout,
    TICKS: { id: "fake-ticks", name: "Fake Ticks" } as const satisfies AppAbout,
    started,
    /** Notes the start, then waits until the loop is ended. */
    begin: (who: string, value: string, signal: AbortSignal) =>
      new Promise<void>((ended) => {
        started.push({ who, with: value, signal });
        if (signal.aborted) ended();
        else signal.addEventListener("abort", () => ended(), { once: true });
      }),
  };
});

vi.mock(import("../apps/index.generated.ts"), async (original) => {
  const { z } = await import("zod");
  const { defineApp } = await import("../apps/contract.ts");
  const { setting } = await import("../settings.ts");
  const source = (who: string, configured: () => string | undefined) => ({
    guide: "",
    condition: z.record(z.string(), z.unknown()),
    configured: () => configured() !== undefined,
    // A source that only waits: it reads its key as it starts, as a stream opened with it would,
    // and marks where it got to once it is ended.
    async *run({ signal }: { readonly signal: AbortSignal }) {
      await begin(who, configured()!, signal);
      yield { fires: [], cursor: "ended" };
    },
  });
  const generated = await original();
  return {
    ...generated,
    APPS: [
      // The runner asks the wallet for sends it signed and never broadcast, as it starts.
      ...generated.APPS.filter((app) => app.wallet),
      defineApp({
        about: CHAT,
        channel: {
          configured: () => setting(CHAT, "token") !== undefined,
          listen: (_receive, signal) => begin(CHAT.id, setting(CHAT, "token")!, signal),
          send: async () => [],
          edit: async () => false,
          typing: async () => {},
          pairingHint: async () => "",
        },
      }),
      // A source with lookups too, as Elfa has: the owner acts through it, so it has a switch.
      defineApp({
        about: NEWS,
        lookups: () => [],
        watches: source(NEWS.id, () => setting(NEWS, "key")),
      }),
      // One that needs no key, as the prices source needs none: it is running before any is saved.
      defineApp({ about: TICKS, watches: source(TICKS.id, () => "no key") }),
    ] as never,
  };
});

const real = process.env.AUNI_HOME;
let runner: Runner | undefined;
beforeEach(() => {
  process.env.AUNI_HOME = tempDir("auni-loops-");
  started.length = 0;
});
afterEach(async () => {
  await runner?.stop();
  runner = undefined;
  process.env.AUNI_HOME = real;
  for (const each of [CHAT.settings.token.env, NEWS.settings.key.env, "APPS_OFF"])
    delete process.env[each];
});

/** Waits until `who` has started `times` times; far less than the ten seconds a cron would take. */
async function untilStarted(who: string, times: number) {
  const deadline = Date.now() + 4_000;
  const of = () => started.filter((each) => each.who === who);
  while (of().length < times) {
    if (Date.now() > deadline) throw new Error(`${who} started ${of().length} times, not ${times}`);
    await sleep(20);
  }
  return of();
}

describe("a setting saved while Auni runs", () => {
  it("has a channel listen with its replaced token at once, the old listener ended first", async () => {
    await saveSetting("FAKE_CHAT_TOKEN", "first-token");
    runner = await startRunner([channelsJob]);
    const [first] = await untilStarted(CHAT.id, 1);
    expect(first).toMatchObject({ with: "first-token", signal: { aborted: false } });

    await saveSetting("FAKE_CHAT_TOKEN", "second-token");
    const [, second] = await untilStarted(CHAT.id, 2);
    expect(second).toMatchObject({ with: "second-token", signal: { aborted: false } });
    // Two listeners on one bot would split its messages between them.
    expect(first!.signal.aborted).toBe(true);
  });

  it("starts a source whose key was just saved, beside one already running", async () => {
    runner = await startRunner([sourcesJob]);
    await untilStarted(TICKS.id, 1);
    expect(started.map(({ who }) => who)).toEqual([TICKS.id]);

    await saveSetting("FAKE_NEWS_KEY", "news-key");
    const [news] = await untilStarted(NEWS.id, 1);
    expect(news).toMatchObject({ with: "news-key", signal: { aborted: false } });
    // The one that was running started again too, from where its cursor was saved.
    const ticks = await untilStarted(TICKS.id, 2);
    expect(ticks.map(({ signal }) => signal.aborted)).toEqual([true, false]);
  });

  it("stops listening on a channel the owner turns off, and listens again once it is back on", async () => {
    await saveSetting("FAKE_CHAT_TOKEN", "first-token");
    runner = await startRunner([channelsJob]);
    const [first] = await untilStarted(CHAT.id, 1);

    await saveSwitch(CHAT.id, false);
    await vi.waitFor(() => expect(first!.signal.aborted).toBe(true));
    // Off, the job finds no channel to listen on, however often its cron starts it.
    await sleep(300);
    expect(started.filter(({ who }) => who === CHAT.id)).toHaveLength(1);

    // Back on, the job's next start (its cron's, within ten seconds) listens again.
    await saveSwitch(CHAT.id, true);
    const stop = new AbortController();
    const listening = listenOnChannels(stop.signal);
    const [, second] = await untilStarted(CHAT.id, 2);
    expect(second).toMatchObject({ with: "first-token", signal: { aborted: false } });
    stop.abort();
    await listening;
  });

  it("stops a source the owner turns off, and leaves the others running", async () => {
    await saveSetting("FAKE_NEWS_KEY", "news-key");
    runner = await startRunner([sourcesJob]);
    const [news] = await untilStarted(NEWS.id, 1);

    await saveSwitch(NEWS.id, false);
    const ticks = await untilStarted(TICKS.id, 2);
    expect(ticks.at(-1)!.signal.aborted).toBe(false);
    expect(news!.signal.aborted).toBe(true);
    expect(started.filter(({ who }) => who === NEWS.id)).toHaveLength(1);
    // A source with nothing the owner acts through has no switch to turn.
    await expect(saveSwitch(TICKS.id, false)).rejects.toThrow(/can turn on or off/u);
  });
});
