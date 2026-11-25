import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tempDir } from "../test/temp-dir.ts";
import { requireOwner } from "../auth/middleware.ts";
import { mintPairingCode, pair, SESSION_COOKIE, signOutEverywhere } from "../auth/owner.ts";
import { publishThread } from "../conversation/threads.ts";
import { publishThreadEvent } from "../conversation/stream.ts";
import { ownerSessions, threads } from "../db/schema.ts";
import { saveSwitch } from "../settings.ts";
import { insertThread, wipe } from "../test/db.ts";
import { serve } from "../test/serve.ts";
import { liveRouter, PING_MS } from "./live.ts";

// Counts the streams listening, to see one stop when its tab goes.
const listening = vi.hoisted(() => ({ count: 0 }));
vi.mock("../conversation/stream.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../conversation/stream.ts")>();
  return {
    ...original,
    onLive: (listener: Parameters<typeof original.onLive>[0]) => {
      listening.count += 1;
      const stop = original.onLive(listener);
      return () => {
        listening.count -= 1;
        stop();
      };
    },
  };
});

// As server.ts mounts it.
const url = serve(express().use("/live", requireOwner, liveRouter));

let cookie: string;
beforeEach(async () => {
  await wipe(ownerSessions, threads);
  cookie = `${SESSION_COOKIE}=${await pair(await mintPairingCode())}`;
});
afterEach(() => vi.useRealTimers());

/** Opens the stream; `until` reads on until what has arrived passes a test. */
async function open(abort = new AbortController()) {
  const response = await fetch(url("/live"), { headers: { cookie }, signal: abort.signal });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  const until = async (done: (text: string) => boolean): Promise<string> => {
    while (!done(text)) {
      const next = await reader.read();
      if (next.done) break;
      text += next.value;
    }
    return text;
  };
  return { response, until, abort: () => abort.abort() };
}

/** The `data:` messages a stream carried, parsed. */
const messages = (text: string): unknown[] =>
  text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as unknown);

const progress = (turnId: string) => ({ kind: "progress", turnId, stage: "thinking" }) as const;

describe("GET /live", () => {
  it("refuses a browser without the owner's session", async () => {
    const response = await fetch(url("/live"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "pairing_required" });
  });

  it("is an event stream the rewrite passes through untouched", async () => {
    const live = await open();
    expect(live.response.headers.get("content-type")).toBe("text/event-stream");
    expect(live.response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(await live.until((text) => text.includes("\n\n"))).toBe("retry: 3000\n\n");
    live.abort();
  });

  it("carries a thread's events in order, and its rows", async () => {
    const thread = await insertThread({ title: "Buy SOL" });
    const live = await open();
    // Open means listening: everything published from here on arrives.
    await live.until((text) => text.includes("retry"));
    publishThreadEvent(thread.id, progress("a"));
    publishThreadEvent(thread.id, progress("b"));
    await publishThread(thread.id);
    const text = await live.until((sofar) => messages(sofar).length === 3);
    expect(messages(text)).toEqual([
      { topic: "thread", threadId: thread.id, event: progress("a") },
      { topic: "thread", threadId: thread.id, event: progress("b") },
      { topic: "row", thread: expect.objectContaining({ id: thread.id, title: "Buy SOL" }) },
    ]);
    live.abort();
  });

  it("says each time a setting is saved, so a tab reads its apps again, and no more once the tab goes", async () => {
    const home = tempDir("auni-live-");
    const real = process.env.AUNI_HOME;
    process.env.AUNI_HOME = home;
    try {
      const live = await open();
      await live.until((text) => text.includes("retry"));
      await saveSwitch("aave", false);
      await saveSwitch("aave", true);
      const text = await live.until((sofar) => messages(sofar).length === 2);
      expect(messages(text)).toEqual([{ topic: "apps" }, { topic: "apps" }]);
      live.abort();
      await vi.waitFor(() => expect(listening.count).toBe(0));
      // A save after the tab has gone writes to no closed stream.
      await saveSwitch("aave", false);
    } finally {
      process.env.AUNI_HOME = real;
      delete process.env.APPS_OFF;
    }
  });

  it("stops listening when the tab goes", async () => {
    const live = await open();
    await live.until((text) => text.includes("retry"));
    expect(listening.count).toBe(1);
    live.abort();
    await vi.waitFor(() => expect(listening.count).toBe(0));
  });

  it("pings while quiet, and ends once the session is signed out", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const live = await open();
    await live.until((text) => text.includes("retry"));
    await vi.advanceTimersByTimeAsync(PING_MS);
    await live.until((text) => text.includes(": ping\n\n"));

    await signOutEverywhere();
    await vi.advanceTimersByTimeAsync(PING_MS);
    const text = await live.until(() => false);
    expect(text.match(/: ping/gu)).toHaveLength(1);
    await vi.waitFor(() => expect(listening.count).toBe(0));
  });
});
