import type { ThreadId } from "@auni/shared";
import type { UIMessageChunk } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CoreApiError } from "@/lib/core";
import { messageText } from "@/lib/conversation";

import { threadSession } from "./thread-session";

const core = vi.hoisted(() => ({ request: vi.fn(), history: [] as unknown[], running: false }));

vi.mock("@/lib/core", async (actual) => ({
  ...(await actual<typeof import("@/lib/core")>()),
  requestCore: core.request,
}));

// The tab's live stream: every listener hears what a test says, and each wait for it to be open
// settles as `opened` says.
const live = vi.hoisted(() => ({
  opened: (): Promise<void> => Promise.resolve(),
  listeners: new Set<{ onMessage: (message: unknown) => void; onGap: () => void }>(),
}));
vi.mock("./live", () => ({
  listenLive: (onMessage: (message: unknown) => void, onGap: () => void = () => {}) => {
    const listener = { onMessage, onGap };
    live.listeners.add(listener);
    return { open: () => live.opened(), close: () => live.listeners.delete(listener) };
  },
}));

function hear(threadId: string, event: unknown) {
  for (const listener of [...live.listeners])
    listener.onMessage({ topic: "thread", threadId, event });
}

function gap() {
  for (const listener of [...live.listeners]) listener.onGap();
}

const PROMPT = "7d0c0000-0000-4000-8000-000000000002";
const STORED = "7d0c0000-0000-4000-8000-00000000000a";

function newThread(): ThreadId {
  return crypto.randomUUID() as ThreadId;
}

/** Core with each send answering the next of `posts`. */
function coreAnswers(...posts: (() => Promise<unknown>)[]) {
  core.request.mockImplementation((path: string, init: RequestInit) => {
    if (path.endsWith("/stop")) return Promise.resolve(undefined);
    if (init.method === "GET")
      return Promise.resolve({ messages: core.history, running: core.running });
    return (posts.shift() ?? accepted)();
  });
}

const accepted = () => Promise.resolve({ turnId: PROMPT });
const lost = () => Promise.reject(new TypeError("Failed to fetch"));

const calls = (match: (path: string, init: RequestInit) => boolean) =>
  core.request.mock.calls.filter(([path, init]) => match(path as string, init as RequestInit));
const posts = () => calls((path, init) => init.method === "POST" && path.endsWith("/messages"));
const stops = () => calls((path) => path.endsWith("/stop"));
const reads = (threadId: ThreadId) =>
  calls((path, init) => init.method === "GET" && path.includes(threadId)).length;

function answerChunks(text: string): UIMessageChunk[] {
  return [
    { type: "start", messageId: STORED },
    { type: "text-start", id: "text-0" },
    { type: "text-delta", id: "text-0", delta: text },
    { type: "text-end", id: "text-0" },
    { type: "finish" },
  ];
}

const textOf = (threadId: ThreadId, id: string) => {
  const message = threadSession(threadId)
    .read()
    .messages.find((entry) => entry.id === id);
  return message ? messageText(message) : undefined;
};

beforeEach(() => {
  core.request.mockReset();
  core.history = [];
  core.running = false;
  live.opened = () => Promise.resolve();
  coreAnswers();
});

describe("a sent message", () => {
  // Its first steps and words are heard however quickly they come.
  it("goes only once the live stream is open", async () => {
    let open = () => {};
    live.opened = () => new Promise((resolve) => (open = resolve));
    const sending = threadSession(newThread()).send("Buy $50 of SOL", { id: PROMPT });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(posts()).toHaveLength(0);
    open();
    await sending;
    expect(posts()).toHaveLength(1);
  });

  it("waits for the stream to be open again when it dropped since it was watched", async () => {
    const session = threadSession(newThread());
    const unsubscribe = session.subscribe(() => {});
    // Dropped: the browser is bringing it back.
    let open = () => {};
    live.opened = () => new Promise((resolve) => (open = resolve));
    const sending = session.send("Buy $50 of SOL", { id: PROMPT });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(posts()).toHaveLength(0);
    open();
    await sending;
    expect(posts()).toHaveLength(1);
    unsubscribe();
  });

  it("isn't sent when the live stream couldn't open, and hands the words back", async () => {
    live.opened = () => Promise.reject(new Error("closed"));
    const session = threadSession(newThread());
    await session.send("Buy $50 of SOL", { id: PROMPT });
    expect(posts()).toHaveLength(0);
    expect(session.read().send?.failure).toBe("unsent");
    expect(session.read().messages).toEqual([]);
  });

  it("draws its own turn through the follower, none of another's, and reads history at its end", async () => {
    const thread = newThread();
    const session = threadSession(thread);
    await session.send("Buy $50 of SOL", { id: PROMPT });
    expect(session.read().turn).toEqual({ id: PROMPT, stage: "submitted", sent: true });

    hear(newThread(), { kind: "chunks", turnId: PROMPT, chunks: answerChunks("no") });
    hear(thread, {
      kind: "chunks",
      turnId: "other-turn",
      chunks: [{ type: "text-delta", id: "t", delta: "no" }],
    });
    hear(thread, { kind: "chunks", turnId: PROMPT, chunks: answerChunks("yes") });
    await vi.waitFor(() => expect(textOf(thread, STORED)).toBe("yes"));
    expect(session.read().turn).toEqual({ id: PROMPT, stage: "streaming", sent: true });

    const before = reads(thread);
    core.history = [
      {
        id: STORED,
        role: "assistant",
        parts: [{ type: "text", text: "yes, stored" }],
        metadata: { origin: "human", replyToId: PROMPT },
      },
    ];
    hear(thread, { kind: "turn-end", turnId: PROMPT });
    expect(session.read().turn).toBeNull();
    await vi.waitFor(() => expect(textOf(thread, STORED)).toBe("yes, stored"));
    expect(reads(thread)).toBe(before + 1);
    expect(session.read().messages.map(({ id }) => id)).toEqual([STORED, PROMPT]);
  });

  it("is never posted when Stop came while the stream was opening", async () => {
    let open = () => {};
    live.opened = () => new Promise((resolve) => (open = resolve));
    const session = threadSession(newThread());
    const sending = session.send("Buy $50 of SOL", { id: PROMPT });
    await session.stop();
    open();
    await sending;
    expect(posts()).toHaveLength(0);
    expect(stops()).toHaveLength(0);
    expect(session.read()).toMatchObject({ messages: [], turn: null, send: null });
  });

  it("is stopped again once a send in flight settles", async () => {
    let answer = () => {};
    coreAnswers(() => new Promise((resolve) => (answer = () => resolve({ turnId: PROMPT }))));
    const session = threadSession(newThread());
    const sending = session.send("Buy $50 of SOL", { id: PROMPT });
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    const stopping = session.stop();
    expect(session.read().turn).toBeNull();
    await vi.waitFor(() => expect(stops()).toHaveLength(1));
    answer();
    await Promise.all([sending, stopping]);
    expect(stops()).toHaveLength(2);
  });

  it("sends the same message again when its response was lost", async () => {
    coreAnswers(lost, accepted);
    const session = threadSession(newThread());
    await session.send("Buy $50 of SOL", { id: PROMPT });
    expect(session.read().send?.failure).toBeNull();
    expect(posts().map(([, init]) => JSON.parse((init as RequestInit).body as string).id)).toEqual([
      PROMPT,
      PROMPT,
    ]);
  });

  it("is unconfirmed, not unsent, when neither send answers", async () => {
    coreAnswers(lost, lost);
    const session = threadSession(newThread());
    await session.send("Buy $50 of SOL", { id: PROMPT });
    expect(session.read().send?.failure).toBe("unconfirmed");
    expect(session.read().messages.map(({ id }) => id)).toEqual([PROMPT]);
  });

  it("is unsent when core refused it", async () => {
    const refusal = new CoreApiError({ message: "refused", status: 400, code: "invalid_body" });
    coreAnswers(() => Promise.reject(refusal));
    const session = threadSession(newThread());
    await session.send("Buy $50 of SOL", { id: PROMPT });
    expect(posts()).toHaveLength(1);
    expect(session.read().send?.failure).toBe("unsent");
    expect(session.read().messages).toEqual([]);
  });

  it("fails as a turn when core ends its turn failed", async () => {
    const thread = newThread();
    const session = threadSession(thread);
    await session.send("Buy $50 of SOL", { id: PROMPT });
    hear(thread, { kind: "turn-end", turnId: PROMPT, failed: true });
    expect(session.read()).toMatchObject({ turn: null, send: { failure: "turn" } });
  });
});

describe("a new thread's start", () => {
  // Core queues the first message's turn as it makes the thread, so its first words can come
  // before core's answer does.
  it("hears its first turn from before core makes the thread, so none of it is missed", async () => {
    let open = () => {};
    live.opened = () => new Promise((resolve) => (open = resolve));
    const thread = newThread();
    const session = threadSession(thread, { isNew: true });
    const create = vi.fn(async () => {
      hear(thread, { kind: "chunks", turnId: PROMPT, chunks: answerChunks("Rates rose.") });
      return { keyKeptOut: false };
    });
    const starting = session.start("Why did BTC fall?", { id: PROMPT }, create);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(create).not.toHaveBeenCalled();
    open();
    await starting;
    await vi.waitFor(() => expect(textOf(thread, STORED)).toBe("Rates rose."));
    expect(session.read().messages.map(({ id }) => id)).toEqual([PROMPT, STORED]);
    expect(session.read().send).toEqual({
      messageId: PROMPT,
      text: "Why did BTC fall?",
      failure: null,
    });
  });

  it("leaves nothing drawn when the thread wasn't made, and says why", async () => {
    const session = threadSession(newThread(), { isNew: true });
    const refused = new CoreApiError({ message: "", status: 502, code: "wallet_not_made" });
    await expect(
      session.start("Why did BTC fall?", { id: PROMPT }, () => Promise.reject(refused)),
    ).rejects.toBe(refused);
    expect(session.read()).toMatchObject({ messages: [], turn: null, send: null });
    expect(posts()).toHaveLength(0);
  });

  it("draws Auni's answer in place of a message kept out for the private key it held", async () => {
    const thread = newThread();
    const session = threadSession(thread, { isNew: true });
    await session.start("my key", { id: PROMPT }, async () => ({ keyKeptOut: true }));
    expect(session.read()).toMatchObject({ messages: [], turn: null, send: null });
    await vi.waitFor(() => expect(reads(thread)).toBeGreaterThan(0));
  });
});

describe("a turn core started on its own", () => {
  it("is starting from its first step, and streams under the id its answer is stored as", async () => {
    const thread = newThread();
    const session = threadSession(thread);
    const unsubscribe = session.subscribe(() => {});
    hear(thread, { kind: "progress", turnId: "turn-1", stage: "thinking" });
    expect(session.read().turn).toEqual({ id: "turn-1", stage: "submitted", sent: false });
    hear(thread, { kind: "chunks", turnId: "turn-1", chunks: answerChunks("Welcome.") });
    await vi.waitFor(() => expect(textOf(thread, STORED)).toBe("Welcome."));
    expect(session.read().messages.map(({ id }) => id)).toEqual([STORED]);
    expect(session.read().turn).toEqual({ id: "turn-1", stage: "streaming", sent: false });
    unsubscribe();
  });

  it("is left to history when the page joined it after it began", async () => {
    const thread = newThread();
    const session = threadSession(thread);
    const unsubscribe = session.subscribe(() => {});
    // Its start went out before the page subscribed; the rest of the answer still arrives.
    hear(thread, {
      kind: "chunks",
      turnId: "turn-1",
      chunks: [{ type: "data-reasoning", id: "r-1", data: { text: "Proposing the picks." } }],
    });
    hear(thread, { kind: "chunks", turnId: "turn-1", chunks: answerChunks("Welcome.").slice(1) });
    const before = reads(thread);
    hear(thread, { kind: "turn-end", turnId: "turn-1" });
    await vi.waitFor(() => expect(reads(thread)).toBe(before + 1));
    expect(session.read().messages).toEqual([]);
    unsubscribe();
  });
});

describe("a session", () => {
  it("keeps a turn core still runs across a gap, as thinking, until its end", async () => {
    const thread = newThread();
    const session = threadSession(thread);
    const unsubscribe = session.subscribe(() => {});
    hear(thread, { kind: "chunks", turnId: "turn-1", chunks: answerChunks("Hel").slice(0, 3) });
    await vi.waitFor(() => expect(textOf(thread, STORED)).toBe("Hel"));
    core.running = true;
    const before = reads(thread);
    gap();
    expect(session.read().turn).toEqual({ id: "turn-1", stage: "submitted", sent: false });
    await vi.waitFor(() => expect(reads(thread)).toBe(before + 1));
    expect(session.read().turn).toEqual({ id: "turn-1", stage: "submitted", sent: false });
    // What streams after the gap is history's to show; its start was before it.
    hear(thread, {
      kind: "chunks",
      turnId: "turn-1",
      chunks: [{ type: "text-delta", id: "text-0", delta: "lo" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(textOf(thread, STORED)).toBe("Hel");
    hear(thread, { kind: "turn-end", turnId: "turn-1" });
    expect(session.read().turn).toBeNull();
    unsubscribe();
  });

  it("drops a turn that ended during a gap once history says none runs", async () => {
    const thread = newThread();
    const session = threadSession(thread);
    const unsubscribe = session.subscribe(() => {});
    await session.send("Buy $50 of SOL", { id: PROMPT });
    hear(thread, { kind: "chunks", turnId: PROMPT, chunks: answerChunks("Hel").slice(0, 3) });
    // Its end went out while the stream was down.
    core.history = [
      {
        id: STORED,
        role: "assistant",
        parts: [{ type: "text", text: "Hello" }],
        metadata: { origin: "human", replyToId: PROMPT },
      },
    ];
    await vi.waitFor(() => expect(textOf(thread, STORED)).toBe("Hel"));
    gap();
    await vi.waitFor(() => expect(session.read().turn).toBeNull());
    expect(textOf(thread, STORED)).toBe("Hello");
    unsubscribe();
  });

  it("outlives the others while its turn streams, and an idle one is trimmed", async () => {
    let answer = () => {};
    coreAnswers(() => new Promise((resolve) => (answer = () => resolve({ turnId: PROMPT }))));
    const streaming = newThread();
    const idle = newThread();
    const kept = threadSession(streaming);
    const sending = kept.send("Buy $50 of SOL", { id: PROMPT });
    const trimmed = threadSession(idle);
    for (let index = 0; index < 24; index += 1) threadSession(newThread());
    expect(threadSession(streaming)).toBe(kept);
    expect(threadSession(idle)).not.toBe(trimmed);
    await vi.waitFor(() => expect(posts()).toHaveLength(1));
    answer();
    await sending;
  });
});
