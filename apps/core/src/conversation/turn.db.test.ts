import { readFileSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { eq } from "drizzle-orm";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, automationFires, automations, jobs, messages, threads } from "../db/schema.ts";
import type { BrainEvent } from "../apps/contract.ts";
import { sealCard } from "../agent/card-seal.ts";
import { mcpRouter } from "../agent/mcp.ts";
import { turnJob } from "../jobs/turn.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import { serve } from "../test/serve.ts";
import { sendMessage } from "./send.ts";
import { stopTurn } from "./stop.ts";
import { threadById } from "./threads.ts";
import { onLive } from "./stream.ts";
import { runConversationTurn } from "./turn.ts";
import { recordedAsItGoes } from "./turn-record.ts";
import { suggestRepliesTool } from "../agent/replies.ts";

// A background turn run end to end on a brain that replays recorded events.

const replay = vi.hoisted(() => ({
  events: [] as unknown[],
  /** Runs as the brain starts, as a tool it calls would, with the token its turn was given. */
  during: undefined as ((token: string) => Promise<unknown>) | undefined,
  /** After its events the brain waits: until the turn is stopped, or for ever, as a process that died. */
  waits: undefined as "for-a-stop" | "for-ever" | undefined,
  /** Whether the brain has said its events and now waits. */
  waiting: false,
  /** What each turn was asked, in order. */
  prompts: [] as string[],
  /** No brain can think here: pickBrain finds only what the owner would run. */
  noBrain: false,
}));
vi.mock("../agent/brain.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../agent/brain.ts")>();
  return {
    ...real,
    pickBrain: async () =>
      replay.noBrain
        ? { fixes: ["Claude Code: claude auth login"] }
        : {
            about: { id: "fake", name: "Fake" },
            login: "test",
            brain: {
              async *run(turn: { prompt: string[]; mcp: { token: string } }, signal: AbortSignal) {
                replay.prompts.push(turn.prompt.join(""));
                await replay.during?.(turn.mcp.token);
                yield* replay.events as BrainEvent[];
                replay.waiting = true;
                if (replay.waits === "for-ever") await new Promise(() => {});
                if (replay.waits === "for-a-stop")
                  await new Promise((stopped) => signal.addEventListener("abort", stopped));
              },
            },
          },
    brainBox: async () => ({}),
    limitNotice: async (picked: { about: { name: string } }, resetsAt: Date | null) =>
      `${picked.about.name} has reached its usage limit. Auni can answer again ${resetsAt ? "then" : "once it resets"}.`,
  };
});
/** Runs as suggest_replies is called, before it answers. */
const atSuggest = vi.hoisted(() => ({ run: undefined as (() => Promise<void>) | undefined }));
vi.mock("../agent/replies.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../agent/replies.ts")>();
  return {
    ...real,
    suggestRepliesTool: (turn: Parameters<typeof real.suggestRepliesTool>[0]) => {
      const tool = real.suggestRepliesTool(turn);
      return {
        ...tool,
        handler: async (input: Parameters<typeof tool.handler>[0]) => {
          await atSuggest.run?.();
          return tool.handler(input);
        },
      };
    },
  };
});
vi.mock("../agent/prompt.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/prompt.ts")>()),
  systemPrompt: async () => "You are Auni.",
}));
vi.mock("../money/wallets.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../money/wallets.ts")>()),
  walletAddresses: async () => null,
}));

function fixture(name: string): unknown[] {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
}

beforeEach(async () => {
  atSuggest.run = undefined;
  replay.during = undefined;
  replay.waits = undefined;
  replay.waiting = false;
  replay.prompts = [];
  replay.noBrain = false;
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await wipe(threads, messages, automations, automationFires, actions, jobs);
});

/** A thread with a watch whose fire triage judged to wake it, or held for the brief. */
async function firedWatch(verdict: "wake" | "brief" = "wake") {
  const thread = await insertThread();
  const [watch] = await db
    .insert(automations)
    .values({
      threadId: thread.id,
      source: "prices",
      condition: { coin: "ETH", below: 2000 },
      description: "ETH under $2,000",
      note: "They want to add to ETH under $2,000.",
    })
    .returning();
  const [fire] = await db
    .insert(automationFires)
    .values({
      automationId: watch!.id,
      eventId: "eth-drop",
      payload: {},
      happenedAt: new Date(),
      verdict,
      reason: "It crossed their level.",
    })
    .returning();
  const fires = [{ automationId: watch!.id, fireId: fire!.id, watch: "ETH under $2,000" }];
  return { thread, fire: fire!, fires };
}

const failing: BrainEvent[] = [
  { type: "ready", model: "fake", login: "test" },
  { type: "text", id: "t1", delta: "Looking at ETH" },
  { type: "error", message: "the CLI crashed" },
];
const answering: BrainEvent[] = [
  { type: "ready", model: "fake", login: "test" },
  { type: "text", id: "t1", delta: "ETH crossed $2,000. Want to add?" },
  { type: "done" },
];

describe("a turn whose brain's login is refused", () => {
  it("keeps an answer that says so, and what the owner runs", async () => {
    const thread = await insertThread();
    const id = crypto.randomUUID();
    await db
      .insert(messages)
      .values({ id, threadId: thread.id, role: "user", parts: [{ type: "text", text: "Hi" }] });
    replay.events = [
      { type: "ready", model: "fake", login: "test" },
      { type: "refused", why: "signed-out", fix: "claude auth login" },
      { type: "error", message: "Invalid API key" },
    ];
    await runConversationTurn({
      threadId: thread.id,
      turnId: id,
      trigger: { kind: "message", messageId: id },
    });
    const [answer] = await db.select().from(messages).where(eq(messages.role, "assistant"));
    expect(answer!.metadata).toMatchObject({ failed: true });
    expect(answer!.parts).toContainEqual(
      expect.objectContaining({
        type: "text",
        // A brain with no sign-in of its own in the web app: the command, where Auni runs.
        text: "Fake couldn't answer: its login was refused. Where Auni runs, run `claude auth login`, then ask again.",
      }),
    );
  });
});

describe("a turn with no brain to think with", () => {
  it("keeps an answer that asks for one, and doesn't end as a failure the browser would show", async () => {
    const thread = await insertThread();
    const id = crypto.randomUUID();
    await db
      .insert(messages)
      .values({ id, threadId: thread.id, role: "user", parts: [{ type: "text", text: "Hi" }] });
    replay.noBrain = true;
    const ends: unknown[] = [];
    const stopHearing = onLive((live) => {
      if (live.topic === "thread" && live.event.kind === "turn-end") ends.push(live.event);
    });
    await runConversationTurn({
      threadId: thread.id,
      turnId: id,
      trigger: { kind: "message", messageId: id },
    });
    stopHearing();
    const [answer] = await db.select().from(messages).where(eq(messages.role, "assistant"));
    expect(answer!.metadata).toMatchObject({ noBrain: true });
    expect(ends).toEqual([{ kind: "turn-end", turnId: id }]);
  });
});

describe("a background turn that settles quietly", () => {
  it("keeps its answer marked quiet, records why as the fire's outcome, and leaves it read", async () => {
    const { thread, fires } = await firedWatch();
    replay.events = fixture("settle-quietly.synthetic.json");

    await runConversationTurn({
      threadId: thread.id,
      turnId: "turn-1",
      trigger: { kind: "background", reason: "Your watch fired.", fires },
    });

    const [answer] = await db.select().from(messages).where(eq(messages.threadId, thread.id));
    expect(answer!.metadata).toMatchObject({
      quiet: "ETH wicked under $2,000 and recovered within the minute",
      fires,
    });
    expect(answer!.parts).toContainEqual(
      expect.objectContaining({ type: "tool-settle_quietly", state: "output-available" }),
    );
    const [settled] = await db.select().from(automationFires);
    expect(settled).toMatchObject({
      messageId: answer!.id,
      outcome: "Stayed quiet: ETH wicked under $2,000 and recovered within the minute",
    });
    const [after] = await db.select().from(threads).where(eq(threads.id, thread.id));
    expect(after).toMatchObject({ repliedAt: null, turnStartedAt: null });
  });
  // A quiet call beside words or a card used to hide them all: the web app dropped the answer and
  // no channel heard of it, a warning or a waiting card included (2026-11-25 review).
  const quietly = fixture("settle-quietly.synthetic.json").slice(1, -1) as BrainEvent[];
  const cases: [string, (threadId: string) => Promise<BrainEvent[]>][] = [
    [
      "beside words it wrote first",
      async () => [
        { type: "ready", model: "fake", login: "test" },
        { type: "text", id: "t1", delta: "The sale left $40 on Polygon." },
        ...quietly,
        { type: "done" },
      ],
    ],
    [
      "beside a card it put up",
      async (threadId) => [
        { type: "ready", model: "fake", login: "test" },
        ...cardFor((await insertAction({ threadId, status: "awaiting_permission" })).id),
        ...quietly,
        { type: "done" },
      ],
    ],
    [
      "before a usage limit cut it off",
      async () => [
        { type: "ready", model: "fake", login: "test" },
        ...quietly,
        { type: "limit", resetsAt: new Date(Date.now() + 60 * 60_000) },
        { type: "error", message: "usage limit" },
      ],
    ],
  ];
  it.each(cases)("isn't quiet %s, and is told like any answer", async (_, events) => {
    const { thread, fires } = await firedWatch();
    replay.events = await events(thread.id);

    await runConversationTurn({
      threadId: thread.id,
      turnId: "turn-1",
      trigger: { kind: "background", reason: "Your watch fired.", fires },
    });

    const [answer] = await db.select().from(messages).where(eq(messages.threadId, thread.id));
    expect(answer!.metadata).not.toHaveProperty("quiet");
    expect((await threadRow(thread.id)).repliedAt).not.toBeNull();
  });
});

describe("a background turn that fails", () => {
  it("before doing anything keeps and tells nothing, and asks to run again", async () => {
    const { thread, fires } = await firedWatch();
    replay.events = failing;
    const trigger = { kind: "background", reason: "Your watch fired.", fires } as const;

    const first = await runConversationTurn({ threadId: thread.id, turnId: "t", trigger });

    expect(first).toEqual({ again: 5 * 60_000 });
    expect(await db.select().from(messages)).toEqual([]);
    expect(await db.select().from(jobs)).toEqual([]);
    expect((await db.select().from(automationFires))[0]).toMatchObject({
      messageId: null,
      outcome: null,
    });
    const [after] = await db.select().from(threads).where(eq(threads.id, thread.id));
    expect(after).toMatchObject({ turnStartedAt: null, repliedAt: null });

    // Run again, the same wake answers, and only then are its fires told.
    replay.events = answering;
    expect(
      await runConversationTurn({ threadId: thread.id, turnId: "t", trigger }),
    ).toBeUndefined();
    const [answer] = await db.select().from(messages);
    expect((await db.select().from(automationFires))[0]).toMatchObject({
      messageId: answer!.id,
      outcome: "ETH crossed $2,000.",
    });
  });

  it("at a usage limit runs again once the brain is back", async () => {
    const { thread } = await firedWatch();
    const resetsAt = new Date(Date.now() + 2 * 60 * 60_000);
    replay.events = [
      { type: "ready", model: "fake", login: "test" },
      { type: "limit", resetsAt },
      { type: "error", message: "usage limit" },
    ];
    const before = Date.now();
    const again = await runConversationTurn({
      threadId: thread.id,
      turnId: "t",
      trigger: { kind: "background", reason: "Your watch fired." },
    });
    expect(again!.again).toBeGreaterThan(resetsAt.getTime() - Date.now() - 5_000);
    expect(again!.again).toBeLessThanOrEqual(resetsAt.getTime() - before);
    expect(await db.select().from(messages)).toEqual([]);
  });

  it("after recording a move is kept, never run again, and leaves its fires untold", async () => {
    const { thread, fires } = await firedWatch();
    replay.events = failing;
    replay.during = () => insertAction({ threadId: thread.id });

    const again = await runConversationTurn({
      threadId: thread.id,
      turnId: "t",
      trigger: { kind: "background", reason: "Your watch fired.", fires },
    });

    expect(again).toBeUndefined();
    const [kept] = await db.select().from(messages);
    expect(kept!.metadata).toMatchObject({ failed: true, fires });
    expect((await db.select().from(automationFires))[0]).toMatchObject({ messageId: null });
  });

  it("for a day is kept as failed, saying so, with what woke it left untold", async () => {
    const { thread, fires } = await firedWatch();
    replay.events = failing;
    const again = await runConversationTurn({
      threadId: thread.id,
      turnId: "t",
      trigger: { kind: "background", reason: "Your watch fired.", fires },
      queuedAt: new Date(Date.now() - 25 * 60 * 60_000),
    });
    expect(again).toBeUndefined();
    const [kept] = await db.select().from(messages);
    expect(kept!.metadata).toMatchObject({ failed: true, reason: "Your watch fired." });
    expect(JSON.stringify(kept!.parts)).toContain("couldn't think for a day");
    expect((await db.select().from(automationFires))[0]).toMatchObject({ messageId: null });
  });
});

describe("the daily brief's held fires", () => {
  it("stay unbriefed until a brief that didn't fail is kept", async () => {
    const { thread, fire } = await firedWatch("brief");
    const trigger = {
      kind: "background",
      reason: "It's the owner's morning.",
      briefed: [fire.id],
    } as const;

    replay.events = failing;
    await runConversationTurn({ threadId: thread.id, turnId: "t", trigger });
    expect((await db.select().from(automationFires))[0]!.briefedAt).toBeNull();

    replay.events = answering;
    await runConversationTurn({ threadId: thread.id, turnId: "t", trigger });
    expect((await db.select().from(automationFires))[0]!.briefedAt).toBeInstanceOf(Date);
  });
});

/** An owner's message in a thread, as a channel or the web app stores it. */
async function ownerSaid(threadId: string, text: string, channel?: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(messages).values({
    id,
    threadId,
    role: "user",
    parts: [{ type: "text", text }],
    metadata: channel ? { channel } : {},
  });
  return id;
}

/** A sealed card for a move, as a money tool returns it. */
function cardFor(actionId: string): BrainEvent[] {
  const card = { kind: "action", id: actionId, actionReference: actionId, title: "Buy Nvidia" };
  const sealed = sealCard({ content: [], structuredContent: { card } });
  return [
    { type: "tool-call", id: "call-1", name: "stock_trade", input: { usd: 10 } },
    { type: "tool-result", id: "call-1", output: sealed.structuredContent, isError: false },
  ];
}

const threadRow = async (id: string) =>
  (await db.select().from(threads).where(eq(threads.id, id)))[0]!;

/** Whether the thread's running turn has `words` on its record. */
const saidSoFar = async (threadId: string, words: string) =>
  JSON.stringify((await threadRow(threadId)).answerSoFar?.parts ?? []).includes(words);

async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** The runner's view of a turn job cut off when Auni died, as it settles it on starting again. */
const cutOffRun = (attempts = 1) => ({
  id: crypto.randomUUID(),
  createdAt: new Date(),
  attempts,
  signal: AbortSignal.abort(),
});

describe("a turn cut off when Auni dies", () => {
  it("keeps what the owner saw, says it was cut off with a reply that asks again, and sends that to their channel", async () => {
    const thread = await insertThread();
    const messageId = await ownerSaid(thread.id, "Buy me some Nvidia", "telegram");
    await db.update(threads).set({ turnStartedAt: new Date() }).where(eq(threads.id, thread.id));
    const shown = await insertAction({ threadId: thread.id, status: "awaiting_permission" });
    replay.events = [
      { type: "ready", model: "fake", login: "test" },
      { type: "text", id: "t1", delta: "Here is a card for it." },
      ...cardFor(shown.id),
      { type: "text", id: "t2", delta: "It buys $10 of" },
    ];
    replay.waits = "for-ever";
    // What the thread held the moment the owner's tab heard the card.
    const atCard: Promise<unknown>[] = [];
    const stopHearing = onLive((live) => {
      if (live.topic === "thread" && live.event.kind === "chunks")
        if (live.event.chunks.some(({ type }) => type === "data-cards"))
          atCard.push(threadRow(thread.id).then(({ answerSoFar }) => answerSoFar?.parts));
    });
    void runConversationTurn({
      threadId: thread.id,
      turnId: messageId,
      trigger: { kind: "message", messageId },
    });
    // As it goes: the card at once, the words within a couple of seconds.
    await until(() => saidSoFar(thread.id, "It buys $10 of"));
    stopHearing();
    expect(await Promise.all(atCard)).toEqual([
      expect.arrayContaining([expect.objectContaining({ type: "data-cards" })]),
    ]);
    // A card recorded in the last instant, whose result never reached the owner.
    const unseen = await insertAction({ threadId: thread.id, status: "awaiting_permission" });

    // Auni dies here, and the runner that starts next finds the job cut off.
    expect(
      await turnJob.cutShort!({ threadId: thread.id, messageId }, cutOffRun(), "crashed"),
    ).toBeUndefined();

    const said = await db.select().from(messages).where(eq(messages.threadId, thread.id));
    const answer = said.find(({ role }) => role === "assistant")!;
    expect(said).toHaveLength(2);
    expect(answer.metadata).toMatchObject({ failed: true });
    expect(answer.metadata).not.toHaveProperty("stopped");
    expect(answer.parts).toEqual([
      expect.objectContaining({ type: "text", text: "Here is a card for it." }),
      expect.objectContaining({ type: "tool-stock_trade", state: "output-available" }),
      expect.objectContaining({ type: "data-cards" }),
      expect.objectContaining({ type: "text", text: "It buys $10 of" }),
      expect.objectContaining({
        type: "text",
        text: "I was cut off partway through this. What I had proposed is on the cards above, and a move you allowed carries on.",
      }),
      expect.objectContaining({
        type: "tool-suggest_replies",
        state: "output-available",
        input: { options: [{ label: "Try again" }] },
      }),
    ]);
    const statuses = await db.select({ id: actions.id, status: actions.status }).from(actions);
    expect(statuses).toContainEqual({ id: shown.id, status: "awaiting_permission" });
    expect(statuses).toContainEqual({ id: unseen.id, status: "replaced" });
    expect(await threadRow(thread.id)).toMatchObject({
      turnStartedAt: null,
      answerSoFar: { turn: messageId, ended: true },
    });
    expect(await queued("deliver")).toEqual([
      expect.objectContaining({
        data: { channel: "telegram", threadId: thread.id, messageId: answer.id },
      }),
    ]);
  });

  it("runs a background turn again that showed nothing, once, and keeps the second cut", async () => {
    const { thread, fires } = await firedWatch();
    await db.update(threads).set({ turnStartedAt: new Date() }).where(eq(threads.id, thread.id));
    const data = { threadId: thread.id, reason: "Your watch fired.", fires };

    expect(await turnJob.cutShort!(data, cutOffRun(1), "crashed")).toBe("rerun");
    expect(await db.select().from(messages)).toEqual([]);
    expect(await threadRow(thread.id)).toMatchObject({ turnStartedAt: null });

    await db.update(threads).set({ turnStartedAt: new Date() }).where(eq(threads.id, thread.id));
    expect(await turnJob.cutShort!(data, cutOffRun(2), "crashed")).toBeUndefined();
    const [kept] = await db.select().from(messages);
    expect(kept!.metadata).toMatchObject({ failed: true, reason: "Your watch fired.", fires });
    expect(JSON.stringify(kept!.parts)).toContain("I was cut off partway through this.");
    expect((await db.select().from(automationFires))[0]).toMatchObject({ messageId: null });
  });
});

// Every moment a turn was killed at on 2026-11-14 (`kill -9` of Auni, then started again), as
// the durable state that moment leaves, and what the runner's settling of its job must make of
// it. A turn that had finished ran again 6 times of 6, and a specialist's finished first turn
// proposed its card twice: whether a turn "did nothing" was read from two fields a finished turn
// had already cleared.
describe("a turn's job found cut off, at each moment Auni can die", () => {
  const NOTHING = "I was cut off partway through this. Nothing was sent or changed.";
  const CARDS =
    "I was cut off partway through this. What I had proposed is on the cards above, and a move you allowed carries on.";
  const STARTED = "I was cut off partway through this. A move I had already started carries on.";
  const BARE = "I was cut off partway through this.";

  interface Scene {
    readonly threadId: string;
    /** The turn: the owner's message, or the background turn's job. */
    readonly turnId: string;
    readonly trigger: Parameters<typeof runConversationTurn>[0]["trigger"];
  }
  /** The record a turn killed midway leaves: what it had shown, and whether it had called a tool. */
  const midway =
    (parts: unknown[], usedTool = false) =>
    ({ threadId, turnId }: Scene) =>
      db
        .update(threads)
        .set({
          turnStartedAt: new Date(),
          answerSoFar: {
            turn: turnId,
            began: new Date().toISOString(),
            parts,
            ...(usedTool ? { usedTool: true as const } : {}),
          },
        })
        .where(eq(threads.id, threadId));
  /** A whole turn run to its end; Auni dies before the runner records that its job ended. */
  const finished =
    (
      events: (scene: Scene) => Promise<BrainEvent[]> | BrainEvent[],
      during?: (scene: Scene) => Promise<unknown>,
    ) =>
    async (scene: Scene) => {
      replay.events = await events(scene);
      replay.during = during && (() => during(scene));
      await runConversationTurn(scene);
    };
  const thinking = { type: "reasoning", text: "ETH is under their level.", state: "done" };
  const words = { type: "text", text: "ETH crossed $2,000.", state: "streaming" };
  const proposing = async ({ threadId }: Scene) => {
    const { id } = await insertAction({ threadId, status: "awaiting_permission" });
    return [answering[0]!, ...cardFor(id), ...answering.slice(1)];
  };

  interface Moment {
    readonly at: string;
    readonly turn: "background" | "message";
    /** The durable state the kill leaves. */
    readonly given: (scene: Scene) => Promise<unknown>;
    /** Whether the job had run before this run (a second cut). */
    readonly attempts?: number;
    readonly verdict: "rerun" | undefined;
    /** The line the chat gains, or null when it gains nothing. */
    readonly says: string | null;
    /** How many answers the thread holds after. */
    readonly answers: number;
    /** Each move's status after. */
    readonly moves?: readonly string[];
  }
  const moments: readonly Moment[] = [
    // A background turn (a watch's wake, a specialist's first turn), cut before it finished.
    {
      at: "as its job started, before the turn began",
      turn: "background",
      given: async () => {},
      verdict: "rerun",
      says: null,
      answers: 0,
    },
    {
      at: "while it was thinking",
      turn: "background",
      given: midway([thinking]),
      verdict: "rerun",
      says: null,
      answers: 0,
    },
    {
      at: "with words begun and no answer kept",
      turn: "background",
      given: midway([thinking, words]),
      verdict: "rerun",
      says: null,
      answers: 0,
    },
    {
      at: "a second time, having done nothing again",
      turn: "background",
      attempts: 2,
      given: midway([thinking]),
      verdict: undefined,
      says: NOTHING,
      answers: 1,
    },
    {
      at: "as a tool of Auni's was about to run, before its step showed",
      turn: "background",
      given: midway([thinking], true),
      verdict: undefined,
      says: BARE,
      answers: 1,
    },
    {
      at: "with a tool's step shown",
      turn: "background",
      given: midway([{ type: "tool-watch", toolCallId: "c", state: "input-available", input: {} }]),
      verdict: undefined,
      says: BARE,
      answers: 1,
    },
    {
      at: "with its card's moves recorded and the card never shown",
      turn: "background",
      given: async (scene) => {
        await midway([thinking], true)(scene);
        await insertAction({ threadId: scene.threadId, status: "awaiting_permission" });
      },
      verdict: undefined,
      says: BARE,
      answers: 1,
      moves: ["replaced"],
    },
    {
      at: "just after its card was shown",
      turn: "background",
      given: async (scene) => {
        const { id } = await insertAction({
          threadId: scene.threadId,
          status: "awaiting_permission",
        });
        await midway(
          [{ type: "data-cards", id: "c", data: { cards: [{ actionReference: id }] } }],
          true,
        )(scene);
      },
      verdict: undefined,
      says: CARDS,
      answers: 1,
      moves: ["awaiting_permission"],
    },
    {
      at: "just after a move it made on its own was queued, its step never shown",
      turn: "background",
      given: async (scene) => {
        await midway([thinking], true)(scene);
        await insertAction({ threadId: scene.threadId, status: "running", phase: "queued" });
      },
      verdict: undefined,
      says: STARTED,
      answers: 1,
      moves: ["running"],
    },
    // The same, with the tool's own record of its call lost: the move alone says it acted.
    {
      at: "with only a move in its thread to show it acted",
      turn: "background",
      given: async (scene) => {
        await midway([thinking])(scene);
        await insertAction({ threadId: scene.threadId, status: "running", phase: "queued" });
      },
      verdict: undefined,
      says: STARTED,
      answers: 1,
      moves: ["running"],
    },
    // A background turn that had finished: its answer kept, its job's end never recorded.
    {
      at: "the instant its answer was kept",
      turn: "background",
      given: finished(() => answering),
      verdict: undefined,
      says: null,
      answers: 1,
    },
    {
      at: "once it finished having proposed a card",
      turn: "background",
      given: finished(proposing),
      verdict: undefined,
      says: null,
      answers: 1,
      moves: ["awaiting_permission"],
    },
    {
      at: "once it finished having made a move of its own",
      turn: "background",
      given: finished(
        () => answering,
        ({ threadId }) => insertAction({ threadId, status: "running", phase: "queued" }),
      ),
      verdict: undefined,
      says: null,
      answers: 1,
      moves: ["running"],
    },
    {
      at: "once it finished with nothing to say",
      turn: "background",
      given: finished(() => [answering[0]!, { type: "done" }]),
      verdict: undefined,
      says: null,
      answers: 0,
    },
    // The owner's own message never runs again by itself, whatever its turn had done.
    {
      at: "while it was thinking",
      turn: "message",
      given: midway([thinking]),
      verdict: undefined,
      says: NOTHING,
      answers: 1,
    },
    {
      at: "before its turn began",
      turn: "message",
      given: async () => {},
      verdict: undefined,
      says: NOTHING,
      answers: 1,
    },
    {
      at: "the instant its answer was kept",
      turn: "message",
      given: finished(() => answering),
      verdict: undefined,
      says: null,
      answers: 1,
    },
    {
      at: "once it finished having proposed a card",
      turn: "message",
      given: finished(proposing),
      verdict: undefined,
      says: null,
      answers: 1,
      moves: ["awaiting_permission"],
    },
    {
      // The answer before it was stopped by the owner, and is still on the thread's record.
      at: "before its turn began, after an answer the owner stopped",
      turn: "message",
      given: ({ threadId }) =>
        db
          .update(threads)
          .set({
            turnStartedAt: new Date(),
            answerSoFar: {
              turn: "the stopped turn",
              began: new Date().toISOString(),
              parts: [words],
            },
          })
          .where(eq(threads.id, threadId)),
      verdict: undefined,
      says: NOTHING,
      answers: 1,
    },
  ];

  it.each(moments)("$turn turn, $at", async (moment) => {
    const { thread, fires } = await firedWatch();
    const reason = "Your watch fired.";
    const scene: Scene =
      moment.turn === "message"
        ? await ownerSaid(thread.id, "How is ETH?").then((messageId) => ({
            threadId: thread.id,
            turnId: messageId,
            trigger: { kind: "message", messageId },
          }))
        : {
            threadId: thread.id,
            turnId: crypto.randomUUID(),
            trigger: { kind: "background", reason, fires },
          };
    await moment.given(scene);
    const before = await db.select().from(messages).where(eq(messages.role, "assistant"));

    const run = { ...cutOffRun(moment.attempts ?? 1), id: scene.turnId };
    const data =
      scene.trigger.kind === "message"
        ? { threadId: thread.id, messageId: scene.turnId }
        : { threadId: thread.id, reason, fires };
    expect(await turnJob.cutShort!(data, run, "crashed")).toBe(moment.verdict);

    const answers = await db.select().from(messages).where(eq(messages.role, "assistant"));
    expect(answers).toHaveLength(moment.answers);
    const added = answers.filter(({ id }) => !before.some((kept) => kept.id === id));
    const said = added.flatMap(({ parts }) =>
      (parts as { type: string; text?: string }[]).filter(({ type }) => type === "text"),
    );
    if (moment.says === null) expect(added).toEqual([]);
    else {
      // The line that says so, with nothing of another turn's above it.
      expect(said.at(-1)?.text).toBe(moment.says);
      expect(JSON.stringify(added[0]!.parts)).toContain("Try again");
      expect(JSON.stringify(added[0]!.parts)).not.toContain("ETH crossed");
    }
    expect((await db.select().from(actions)).map(({ status }) => status)).toEqual(
      moment.moves ?? [],
    );
    // An answer left in the chat, whole or cut off, is unread until the owner opens the thread.
    expect((await threadRow(thread.id)).repliedAt !== null).toBe(moment.answers > 0);
    // Settled a second time, as when the write that ends its job fails again, it changes nothing.
    if (moment.verdict === undefined) {
      expect(await turnJob.cutShort!(data, run, "crashed")).toBeUndefined();
      expect(await db.select().from(messages).where(eq(messages.role, "assistant"))).toHaveLength(
        moment.answers,
      );
      expect((await threadRow(thread.id)).turnStartedAt).toBeNull();
    }
  });
});

describe("a turn that calls one of Auni's tools", () => {
  const mcp = serve(express().use(mcpRouter));

  // A tool can change what no card or move shows (a watch, a routine), and its step reaches the
  // record only once the stream brings it: killed between, the turn read as having done nothing.
  it("has that on its record before the tool runs, so cut off just after it never runs again", async () => {
    const { thread, fires } = await firedWatch();
    const atCall: unknown[] = [];
    atSuggest.run = async () => {
      atCall.push((await threadRow(thread.id)).answerSoFar);
    };
    replay.events = [{ type: "ready", model: "fake", login: "test" }];
    replay.waits = "for-ever";
    const called = new Promise<void>((resolve) => {
      replay.during = async (token) => {
        const client = new Client({ name: "test", version: "0.0.0" });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(mcp("/mcp")), {
            requestInit: { headers: { authorization: `Bearer ${token}` } },
          }),
        );
        await client.callTool({
          name: "suggest_replies",
          arguments: { options: [{ label: "Add to ETH" }] },
        });
        await client.close();
        resolve();
      };
    });
    const job = crypto.randomUUID();
    const reason = "Your watch fired.";
    void runConversationTurn({
      threadId: thread.id,
      turnId: job,
      trigger: { kind: "background", reason, fires },
    });
    await called;
    expect(atCall).toEqual([expect.objectContaining({ turn: job, usedTool: true })]);

    // Auni dies here: nothing it showed says a tool ran, and its record does.
    const data = { threadId: thread.id, reason, fires };
    expect(await turnJob.cutShort!(data, { ...cutOffRun(), id: job }, "crashed")).toBeUndefined();
    const [kept] = await db.select().from(messages);
    expect(JSON.stringify(kept!.parts)).toContain("I was cut off partway through this.");
    expect(JSON.stringify(kept!.parts)).not.toContain("Nothing was sent or changed");
  });
});

describe("a question asked with suggest_replies", () => {
  async function asked(parts: unknown[]): Promise<string> {
    const thread = await insertThread();
    const recorder = recordedAsItGoes(thread.id, {
      turn: crypto.randomUUID(),
      began: new Date().toISOString(),
    });
    recorder.save(parts as { type: string }[]);
    const result = await suggestRepliesTool({ threadId: thread.id }).handler({
      options: [{ label: "Sell my No shares" }],
    });
    await recorder.end();
    return (result.content[0] as { text: string }).text;
  }

  // A reply drafted only in thinking left the owner a bare "just tap one" under the picker.
  it("tells the agent the owner has seen nothing when only its thinking has said it", async () => {
    const said = await asked([
      { type: "tool-polymarket_order", state: "output-error" },
      { type: "data-reasoning", data: { text: "I couldn't place the bet because..." } },
    ]);
    expect(said).toContain("has seen no words from you yet");
  });

  // Words before an earlier step were said on the way, not the reply.
  it("tells the agent its reply is showing once it is written, and only then", async () => {
    expect(
      await asked([
        { type: "text", text: "Looking it up." },
        { type: "tool-polymarket_markets", state: "output-available" },
        { type: "text", text: "Polymarket won't take this bet from Australia." },
        { type: "tool-suggest_replies", state: "input-available" },
      ]),
    ).toContain("can see your reply");
    expect(
      await asked([
        { type: "text", text: "Looking it up." },
        { type: "tool-polymarket_markets", state: "output-available" },
      ]),
    ).toContain("has seen no words from you yet");
  });

  // Naming the chat once the reply is written leaves the reply where it was.
  it("counts the reply as showing when the chat was named after it", async () => {
    expect(
      await asked([
        { type: "tool-polymarket_markets", state: "output-available" },
        { type: "text", text: "Polymarket won't take this bet from Australia." },
        { type: "tool-name_chat", state: "output-available" },
      ]),
    ).toContain("can see your reply");
  });
});

describe("a turn ended while it runs", () => {
  it("by Auni stopping is kept as cut off, not as the owner's stop", async () => {
    const thread = await insertThread();
    const messageId = await ownerSaid(thread.id, "How is ETH?");
    replay.events = [
      { type: "ready", model: "fake", login: "test" },
      { type: "text", id: "t1", delta: "Looking at ETH" },
    ];
    replay.waits = "for-a-stop";
    const ended = new AbortController();
    const turn = runConversationTurn({
      threadId: thread.id,
      turnId: messageId,
      trigger: { kind: "message", messageId },
      ended: ended.signal,
    });
    await until(async () => saidSoFar(thread.id, "Looking at ETH"));
    ended.abort("stopped");
    await turn;

    const [answer] = await db.select().from(messages).where(eq(messages.role, "assistant"));
    expect(answer!.metadata).not.toHaveProperty("stopped");
    expect(JSON.stringify(answer!.parts)).toContain(
      "I was cut off partway through this. Nothing was sent or changed.",
    );
    expect(await threadRow(thread.id)).toMatchObject({
      turnStartedAt: null,
      answerSoFar: { turn: messageId, ended: true },
    });
  });

  it("by the owner is kept as they stopped it", async () => {
    const thread = await insertThread();
    const messageId = await ownerSaid(thread.id, "How is ETH?");
    replay.events = [
      { type: "ready", model: "fake", login: "test" },
      { type: "text", id: "t1", delta: "Looking at ETH" },
    ];
    replay.waits = "for-a-stop";
    const turn = runConversationTurn({
      threadId: thread.id,
      turnId: messageId,
      trigger: { kind: "message", messageId },
      ended: new AbortController().signal,
    });
    await until(async () => saidSoFar(thread.id, "Looking at ETH"));
    stopTurn(thread.id);
    await turn;

    const [answer] = await db.select().from(messages).where(eq(messages.role, "assistant"));
    expect(answer!.metadata).toMatchObject({ stopped: true });
    expect(JSON.stringify(answer!.parts)).not.toContain("cut off");
    // Asking again is one tap, docked where a cut-off answer docks it.
    expect(answer!.parts.at(-1)).toMatchObject({
      type: "tool-suggest_replies",
      state: "output-available",
      input: { options: [{ label: "Try again" }] },
    });
  });

  it("in the background by Auni stopping, before doing anything, runs again at once", async () => {
    const { thread, fires } = await firedWatch();
    replay.events = [{ type: "ready", model: "fake", login: "test" }];
    replay.waits = "for-a-stop";
    const ended = new AbortController();
    const turn = runConversationTurn({
      threadId: thread.id,
      turnId: "t",
      trigger: { kind: "background", reason: "Your watch fired.", fires },
      ended: ended.signal,
    });
    await until(async () => replay.waiting);
    ended.abort("slept");
    expect(await turn).toEqual({ again: 0 });
    expect(await db.select().from(messages)).toEqual([]);
  });
});

describe("the owner writing again while a turn runs", () => {
  const mcp = serve(express().use(mcpRouter));

  /** Whether one of Auni's tools answers this turn token. */
  async function toolAnswers(token: string): Promise<boolean> {
    const client = new Client({ name: "test", version: "0.0.0" });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(mcp("/mcp")), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      const result = await client.callTool({
        name: "suggest_replies",
        arguments: { options: [{ label: "Show my holdings" }] },
      });
      return !result.isError;
    } catch {
      return false;
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  /** The owner's message, sent as a channel or the web app sends it. */
  async function sends(threadId: string, text: string, supersedesId?: string): Promise<string> {
    const id = crypto.randomUUID();
    const thread = (await threadById(threadId))!;
    await sendMessage(thread, {
      id,
      text,
      channel: "telegram",
      ...(supersedesId ? { supersedesId } : {}),
    });
    return id;
  }

  it("never cuts it short: it finishes and is sent, and the new message is answered next", async () => {
    const thread = await insertThread();
    const first = await sends(thread.id, "What's my balance?");
    let firstToken = "";
    let next = "";
    let toolsWorked = false;
    replay.during = async (token) => {
      firstToken = token;
      next = await sends(thread.id, "And my positions?");
      // Its tools still answer it after the new message is stored.
      toolsWorked = await toolAnswers(token);
    };
    replay.events = [
      { type: "ready", model: "fake", login: "test" },
      { type: "text", id: "t1", delta: "You hold $12." },
      { type: "done" },
    ];
    await runConversationTurn({
      threadId: thread.id,
      turnId: first,
      trigger: { kind: "message", messageId: first },
    });

    expect(toolsWorked).toBe(true);
    const [answer] = await db.select().from(messages).where(eq(messages.role, "assistant"));
    expect(answer!.metadata).not.toHaveProperty("stopped");
    expect(JSON.stringify(answer!.parts)).toContain("You hold $12.");
    expect((await queued("deliver")).map(({ data }) => data)).toEqual([
      { channel: "telegram", threadId: thread.id, messageId: answer!.id },
    ]);
    expect((await queued("turn")).map(({ data }) => data.messageId)).toEqual([first, next]);
    // Still showing a turn to come, while the ended turn's token is spent.
    expect((await threadRow(thread.id)).turnStartedAt).not.toBeNull();
    expect(await toolAnswers(firstToken)).toBe(false);

    replay.during = undefined;
    replay.events = answering;
    await runConversationTurn({
      threadId: thread.id,
      turnId: next,
      trigger: { kind: "message", messageId: next },
    });
    // It sees the first question and its answer, and then answers its own.
    expect(replay.prompts[1]).toContain("User: What's my balance?\n\nAuni: You hold $12.");
    expect(replay.prompts[1]?.endsWith("And my positions?")).toBe(true);
    expect((await threadRow(thread.id)).turnStartedAt).toBeNull();
  });

  it("by editing the words it answers stops it, and editing a later one does not", async () => {
    const thread = await insertThread();
    const first = await sends(thread.id, "How is ETH?");
    replay.events = [
      { type: "ready", model: "fake", login: "test" },
      { type: "text", id: "t1", delta: "Looking at ETH" },
    ];
    replay.waits = "for-a-stop";
    let ended = false;
    const turn = runConversationTurn({
      threadId: thread.id,
      turnId: first,
      trigger: { kind: "message", messageId: first },
    }).then(() => (ended = true));
    await until(async () => saidSoFar(thread.id, "Looking at ETH"));

    const later = await sends(thread.id, "And BTC?");
    await sends(thread.id, "And SOL?", later);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(ended).toBe(false);

    await sends(thread.id, "How is ETH today?", first);
    await turn;
    const [answer] = await db.select().from(messages).where(eq(messages.role, "assistant"));
    expect(answer!.metadata).toMatchObject({ stopped: true });
  });
});
