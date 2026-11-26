import { homedir } from "node:os";

import type { AppAbout } from "@auni/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { tempDir } from "../test/temp-dir.ts";
import { dataDir, settingsFile } from "../data-dir.ts";
import { env } from "../env.ts";
import type { Brain, BrainCheck, BrainEvent, BrainTurn } from "../apps/contract.ts";

const os = vi.hoisted(() => ({ platform: "linux" as NodeJS.Platform }));
vi.mock("node:os", async (actual) => ({
  ...(await actual<typeof import("node:os")>()),
  platform: () => os.platform,
}));

const registered: { about: AppAbout; brain: Brain }[] = [];
vi.mock("../apps/registry.ts", () => ({ brains: () => registered }));
/** Where Postgres says it keeps its files: a folder of the owner's, outside home (embedded, Homebrew). */
const databaseFolder = tempDir("auni-pg-data-", afterAll);
let databaseSays: string | null = databaseFolder;
vi.mock("../db/client.ts", () => ({ databaseFiles: () => Promise.resolve(databaseSays) }));

const brainModule = await import("./brain.ts");
const {
  ON_WINDOWS,
  askFast,
  brainBox,
  brainRows,
  brainSeen,
  brainStatus,
  limitNotice,
  onBrainReady,
  pickBrain,
  runTurn,
  think,
  whichBrainSays,
} = brainModule;

function fakeBrain(
  id: string,
  check: BrainCheck,
  events: readonly BrainEvent[] = [],
): { about: AppAbout; brain: Brain } {
  return {
    about: { id, name: id.toUpperCase() } as AppAbout,
    brain: {
      check: vi.fn(() => Promise.resolve(check)),
      async *run() {
        yield* events;
      },
      secrets: () => [`/secrets/${id}`],
      terminal: () => null,
      computer: "a shell",
      models: "some models",
    },
  };
}

const ready = (id: string) => ({ ...fakeBrain(id, { ready: true, login: id }), login: id });

const turn = { prompt: ["Hi"] } as unknown as BrainTurn;

let clock = Date.now();
beforeEach(() => {
  registered.length = 0;
  vi.useFakeTimers({ toFake: ["Date"] });
  // Each test starts past every check this file memoised before it.
  clock += 60 * 60_000;
  vi.setSystemTime(clock);
});
afterEach(() => {
  vi.useRealTimers();
  env.BRAIN = undefined;
  os.platform = "linux";
});

describe("pickBrain", () => {
  it("takes the first brain that's ready, in the order order.ts gives, and says how to fix the rest", async () => {
    registered.push(
      fakeBrain("a", { ready: false, why: "signed-out", fix: "a login" }),
      fakeBrain("b", { ready: true, login: "b's plan" }),
      fakeBrain("c", { ready: true, login: "c's plan" }),
    );
    expect(await pickBrain()).toMatchObject({ about: { id: "b" }, login: "b's plan" });
    registered.splice(1);
    expect(await pickBrain()).toEqual({ fixes: ["A: a login"] });
  });

  it("takes the brain BRAIN names first, then the rest in order", async () => {
    registered.push(
      fakeBrain("a", { ready: true, login: "a" }),
      fakeBrain("b", { ready: false, why: "signed-out", fix: "b login" }),
      fakeBrain("c", { ready: true, login: "c" }),
    );
    env.BRAIN = "c";
    expect(await pickBrain()).toMatchObject({ about: { id: "c" } });
    env.BRAIN = "b";
    expect(await pickBrain()).toMatchObject({ about: { id: "a" } });
    env.BRAIN = "z";
    expect(await pickBrain()).toEqual({
      fixes: [`BRAIN=z names no brain app: change it in ${settingsFile()}, or remove it.`],
      blocked: true,
    });
  });

  it("says the rule it picks by in one sentence, the order it asks in, and only with a choice to make", async () => {
    registered.push(
      fakeBrain("a", { ready: true, login: "a" }),
      fakeBrain("b", { ready: true, login: "b" }),
    );
    expect(whichBrainSays("~/.auni/.env")).toBe(
      "Auni asks A, then B, and thinks with the first that is ready. You can also pick a model right in any thread.",
    );
    expect(await pickBrain()).toMatchObject({ about: { id: "a" } });
    env.BRAIN = "b";
    expect(whichBrainSays("~/.auni/.env")).toBe(
      "Auni asks B, then A, as BRAIN in ~/.auni/.env says, and thinks with the first that is ready.",
    );
    expect(await pickBrain()).toMatchObject({ about: { id: "b" } });
    registered.splice(1);
    expect(whichBrainSays("~/.auni/.env")).toBeNull();
  });

  it("on Windows, says to run Auni inside WSL, since the box can't run there", async () => {
    const brain = fakeBrain("a", { ready: true, login: "a" });
    registered.push(brain);
    os.platform = "win32";
    expect(await pickBrain()).toEqual({ fixes: [ON_WINDOWS], blocked: true });
    expect(brain.brain.check).not.toHaveBeenCalled();
  });

  it("puts a brain at its usage limit behind any other that's ready, until it resets", async () => {
    const limited = fakeBrain("a", { ready: true, login: "a" }, [
      { type: "limit", resetsAt: new Date(clock + 30 * 60_000) },
      { type: "error", message: "limit" },
    ]);
    registered.push(limited, fakeBrain("b", { ready: true, login: "b" }));
    await runTurn({
      picked: { ...limited, login: "a" },
      turn,
      messageId: "m1",
      metadata: undefined,
      signal: new AbortController().signal,
      onChunk: () => undefined,
    });
    expect(await pickBrain()).toMatchObject({ about: { id: "b" } });
    // Alone, it's tried anyway: its CLI knows best whether the limit lifted.
    registered.splice(1);
    expect(await pickBrain()).toMatchObject({ about: { id: "a" } });
    registered.push(fakeBrain("b", { ready: true, login: "b" }));
    vi.setSystemTime(clock + 31 * 60_000);
    expect(await pickBrain()).toMatchObject({ about: { id: "a" } });
  });

  it("asks a ready CLI again only once five minutes pass", async () => {
    const one = fakeBrain("a", { ready: true, login: "a" });
    registered.push(one);
    await pickBrain();
    vi.setSystemTime(clock + 5 * 60_000 - 1);
    await pickBrain();
    expect(one.brain.check).toHaveBeenCalledTimes(1);
    vi.setSystemTime(clock + 5 * 60_000);
    await pickBrain();
    expect(one.brain.check).toHaveBeenCalledTimes(2);
  });

  it("sees a brain that was just logged in within half a minute", async () => {
    const one = fakeBrain("a", { ready: false, why: "signed-out", fix: "a login" });
    registered.push(one);
    expect(await pickBrain()).toEqual({ fixes: ["A: a login"] });
    vi.mocked(one.brain.check).mockResolvedValue({ ready: true, login: "a's plan" });
    vi.setSystemTime(clock + 30_000 - 1);
    expect(await pickBrain()).toEqual({ fixes: ["A: a login"] });
    vi.setSystemTime(clock + 30_000);
    expect(await pickBrain()).toMatchObject({ about: { id: "a" }, login: "a's plan" });
  });

  it("gives up on a CLI that never answers after 20 seconds, and stops it", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(clock);
    const hung = fakeBrain("a", { ready: true, login: "a" });
    let stopped: AbortSignal | undefined;
    vi.mocked(hung.brain.check).mockImplementation((signal) => {
      stopped = signal;
      return new Promise(() => undefined);
    });
    registered.push(hung, fakeBrain("b", { ready: true, login: "b" }));
    const picking = pickBrain();
    // Whoever asks while it runs waits on the same check.
    const alongside = pickBrain();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await picking).toMatchObject({ about: { id: "b" } });
    expect(await alongside).toMatchObject({ about: { id: "b" } });
    expect(hung.brain.check).toHaveBeenCalledTimes(1);
    expect(stopped?.aborted).toBe(true);
    registered.splice(1);
    expect(await pickBrain()).toEqual({
      fixes: [
        "A: it didn't answer within 20 seconds, so run it in a terminal to see what it waits on",
      ],
    });
  });

  it("asks a CLI that hung again only once five minutes pass, as each try costs 20 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(clock);
    const hung = fakeBrain("a", { ready: true, login: "a" });
    vi.mocked(hung.brain.check).mockImplementation(() => new Promise(() => undefined));
    registered.push(hung, fakeBrain("b", { ready: true, login: "b" }));
    const picking = pickBrain();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await picking).toMatchObject({ about: { id: "b" } });
    vi.setSystemTime(Date.now() + 5 * 60_000 - 1);
    expect(await pickBrain()).toMatchObject({ about: { id: "b" } });
    expect(hung.brain.check).toHaveBeenCalledTimes(1);
    vi.mocked(hung.brain.check).mockResolvedValue({ ready: true, login: "a" });
    vi.setSystemTime(Date.now() + 1);
    expect(await pickBrain()).toMatchObject({ about: { id: "a" } });
    expect(hung.brain.check).toHaveBeenCalledTimes(2);
  });
});

describe("brainStatus", () => {
  it("names the brain, its login and, at its limit with no other ready, until when", async () => {
    const resetsAt = new Date(clock + 30 * 60_000);
    const limited = fakeBrain("a", { ready: true, login: "a's plan" }, [
      { type: "limit", resetsAt },
      { type: "error", message: "limit" },
    ]);
    registered.push(limited);
    expect(await brainStatus()).toEqual({ ready: true, name: "A", login: "a's plan" });
    await runTurn({
      picked: { ...limited, login: "a's plan" },
      turn,
      messageId: "m1",
      metadata: undefined,
      signal: new AbortController().signal,
      onChunk: () => undefined,
    });
    expect(await brainStatus()).toEqual({
      ready: true,
      name: "A",
      login: "a's plan",
      restingUntil: resetsAt,
    });
  });

  it("says what to run while none is ready", async () => {
    registered.push(fakeBrain("a", { ready: false, why: "signed-out", fix: "run a login" }));
    expect(await brainStatus()).toEqual({ ready: false, fixes: ["A: run a login"] });
  });
});

describe("brainRows", () => {
  it("shows every brain in the order a turn asks them: ready, resting until its limit lifts, or why not", async () => {
    const resetsAt = new Date(clock + 30 * 60_000);
    const limited = fakeBrain("b", { ready: true, login: "b's plan" }, [
      { type: "limit", resetsAt },
      { type: "error", message: "limit" },
    ]);
    registered.push(
      fakeBrain("a", { ready: false, why: "not-installed", fix: "install a" }),
      limited,
      fakeBrain("c", { ready: true, login: "c's plan" }),
      fakeBrain("d", { ready: false, why: "signed-out", fix: "d login" }),
    );
    await runTurn({
      picked: { ...limited, login: "b's plan" },
      turn,
      messageId: "m1",
      metadata: undefined,
      signal: new AbortController().signal,
      onChunk: () => undefined,
    });
    expect(await brainRows()).toEqual([
      { id: "a", name: "A", state: "not-installed", fix: "install a" },
      { id: "b", name: "B", state: "resting", login: "b's plan", models: [], until: resetsAt },
      { id: "c", name: "C", state: "ready", login: "c's plan", models: [] },
      { id: "d", name: "D", state: "signed-out", fix: "d login" },
    ]);
  });

  it("says a CLI that throws is broken", async () => {
    const one = fakeBrain("a", { ready: true, login: "a" });
    vi.mocked(one.brain.check).mockRejectedValue(new Error("it crashed"));
    registered.push(one);
    expect(await brainRows()).toEqual([{ id: "a", name: "A", state: "broken", fix: "it crashed" }]);
  });

  it("asks a logged-out brain again within seconds for setup, leaving everyone else the half minute", async () => {
    const one = fakeBrain("a", { ready: false, why: "signed-out", fix: "a login" });
    registered.push(one);
    await brainRows({ notReadyFreshMs: 3_000 });
    vi.mocked(one.brain.check).mockResolvedValue({ ready: true, login: "a's plan" });
    vi.setSystemTime(clock + 3_000 - 1);
    expect((await brainRows({ notReadyFreshMs: 3_000 }))[0]).toMatchObject({ state: "signed-out" });
    vi.setSystemTime(clock + 3_000);
    // A turn still reads the held answer, without spawning the CLI.
    expect(await pickBrain()).toEqual({ fixes: ["A: a login"] });
    expect(one.brain.check).toHaveBeenCalledTimes(1);
    expect((await brainRows({ notReadyFreshMs: 3_000 }))[0]).toMatchObject({ state: "ready" });
    expect(one.brain.check).toHaveBeenCalledTimes(2);
    // Ready holds five minutes for everyone.
    vi.setSystemTime(clock + 60_000);
    await brainRows({ notReadyFreshMs: 3_000 });
    expect(one.brain.check).toHaveBeenCalledTimes(2);
  });

  it("never asks a ready brain again sooner for setup", async () => {
    const one = fakeBrain("a", { ready: true, login: "a" });
    registered.push(one);
    await brainRows({ notReadyFreshMs: 3_000 });
    vi.setSystemTime(clock + 10_000);
    await brainRows({ notReadyFreshMs: 3_000 });
    expect(one.brain.check).toHaveBeenCalledTimes(1);
  });
});

describe("a one-off command, such as auni doctor or auni setup", () => {
  it("calls a brain whose check says ready ready, and never asks its model", async () => {
    const one = fakeBrain("a", { ready: true, login: "a's key" });
    const run = vi.spyOn(one.brain, "run");
    registered.push(one);
    expect(await brainRows()).toEqual([
      { id: "a", name: "A", state: "ready", login: "a's key", models: [] },
    ]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("a login a check sees but a model refuses", () => {
  // Auni itself (start.ts) proves logins; from here on, so does this file.
  beforeAll(() => brainModule.proveLogins());

  const refused = { type: "refused", why: "signed-out", fix: "a login" } as const;
  /** A brain whose check says ready, and whose model answers `events`, changeable meanwhile. */
  function keyed(events: BrainEvent[]) {
    const one = fakeBrain("a", { ready: true, login: "a's key" });
    const run = vi.spyOn(one.brain, "run").mockImplementation(async function* () {
      yield* events;
    });
    return { one, run, answers: (next: BrainEvent[]) => events.splice(0, events.length, ...next) };
  }

  it("isn't ready until its login answers one tiny question, asked once", async () => {
    const { one, run, answers } = keyed([refused, { type: "error", message: "Invalid API key" }]);
    registered.push(one);
    expect(await brainRows({ notReadyFreshMs: 3_000 })).toEqual([
      { id: "a", name: "A", state: "signed-out", fix: "a login" },
    ]);
    expect(run.mock.calls[0]![0]).toMatchObject({ role: "fast", mcp: null });
    expect(await pickBrain()).toEqual({ fixes: ["A: a login"] });
    // A working key, and setup's next look sees it.
    answers([{ type: "done" }]);
    vi.setSystemTime(clock + 3_000);
    expect((await brainRows({ notReadyFreshMs: 3_000 }))[0]).toMatchObject({ state: "ready" });
    vi.setSystemTime(clock + 10 * 60_000);
    expect(await pickBrain()).toMatchObject({ about: { id: "a" } });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("shows signed out once a turn's login is refused, until it answers again", async () => {
    const { one, run, answers } = keyed([{ type: "done" }]);
    registered.push(one);
    expect(await pickBrain()).toMatchObject({ about: { id: "a" } });
    answers([refused, { type: "error", message: "OAuth token has expired" }]);
    const result = await runTurn({
      picked: { ...one, login: "a's key" },
      turn,
      messageId: "m1",
      metadata: undefined,
      signal: new AbortController().signal,
      onChunk: () => undefined,
    });
    expect(result.refused).toEqual({ why: "signed-out", fix: "a login" });
    expect(await pickBrain()).toEqual({ fixes: ["A: a login"] });
    // A starting points ask refused the same way says so too.
    answers([{ type: "done" }]);
    vi.setSystemTime(clock + 30_000);
    expect(await pickBrain()).toMatchObject({ about: { id: "a" } });
    answers([refused, { type: "error", message: "refused" }]);
    await expect(askFast({ systemPrompt: "s", prompt: ["p"] }, 1_000)).rejects.toThrow("refused");
    expect(await brainRows()).toEqual([
      { id: "a", name: "A", state: "signed-out", fix: "a login" },
    ]);
    expect(run).toHaveBeenCalledTimes(4);
  });

  // What `auni` tells the terminal as it starts, while the proof goes on for the first turn.
  it("sees the brain a check found without waiting on its login's proof", async () => {
    let answer: () => void = () => {};
    const asked = new Promise<void>((resolve) => (answer = resolve));
    const { one, run } = keyed([]);
    run.mockImplementation(async function* () {
      await asked;
      yield { type: "done" };
    });
    registered.push(one);
    expect(await brainSeen("auni")).toEqual({ name: "A", line: "A is ready." });
    const picked = pickBrain();
    const later = Symbol("not yet");
    expect(await Promise.race([picked, Promise.resolve(later)])).toBe(later);
    answer();
    expect(await picked).toMatchObject({ about: { id: "a" } });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("shows one AI sign-in command when no brain is ready", async () => {
    const broken = fakeBrain("b", { ready: true, login: "b" });
    vi.mocked(broken.brain.check).mockRejectedValue(new Error("it crashed"));
    registered.push(fakeBrain("a", { ready: false, why: "signed-out", fix: "a login" }), broken);
    expect(await brainSeen("auni")).toEqual({
      name: null,
      line: "A isn't signed in. Run: a login",
    });
    env.BRAIN = "b";
    expect(await brainSeen("auni")).toEqual({
      name: null,
      line: "Couldn't check B. Run: auni doctor --verbose",
    });
  });

  it("tells each listener of every ready answer, until it stops listening", async () => {
    const { one } = keyed([{ type: "done" }]);
    registered.push(one);
    const heard = vi.fn();
    const off = onBrainReady(heard);
    await pickBrain();
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(1));
    // Held five minutes: asking again inside them is no new answer.
    await pickBrain();
    expect(heard).toHaveBeenCalledTimes(1);
    vi.setSystemTime(clock + 10 * 60_000);
    await pickBrain();
    await vi.waitFor(() => expect(heard).toHaveBeenCalledTimes(2));
    off();
    vi.setSystemTime(clock + 20 * 60_000);
    await pickBrain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("tells no listener of an answer that isn't ready", async () => {
    registered.push(fakeBrain("a", { ready: false, why: "signed-out", fix: "a login" }));
    const heard = vi.fn();
    const off = onBrainReady(heard);
    await pickBrain();
    await new Promise((resolve) => setTimeout(resolve, 0));
    off();
    expect(heard).not.toHaveBeenCalled();
  });

  it("stays ready when the question fails some other way, and asks again with the next check", async () => {
    const { one, run } = keyed([{ type: "error", message: "getaddrinfo ENOTFOUND" }]);
    registered.push(one);
    expect(await pickBrain()).toMatchObject({ about: { id: "a" } });
    vi.setSystemTime(clock + 5 * 60_000);
    await pickBrain();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("askFast", () => {
  it("asks the picked brain's fast model, with no tools, in its box", async () => {
    const one = fakeBrain("a", { ready: true, login: "a" }, [{ type: "done", output: { x: 1 } }]);
    const run = vi.spyOn(one.brain, "run");
    registered.push(one);
    expect(await askFast({ systemPrompt: "s", prompt: ["p"] }, 1_000)).toEqual({
      output: { x: 1 },
    });
    expect(run.mock.calls.at(-1)![0]).toMatchObject({ role: "fast", mcp: null, systemPrompt: "s" });
    expect(run.mock.calls.at(-1)![0].box.hidden).toContain(dataDir());
  });

  it("says what to run while no brain is ready", async () => {
    registered.push(fakeBrain("a", { ready: false, why: "signed-out", fix: "a login" }));
    expect(await askFast({ systemPrompt: "s", prompt: ["p"] }, 1_000)).toEqual({
      fixes: ["A: a login"],
    });
  });
});

describe("brainBox", () => {
  it("hides home, Auni's data, the repo and every brain's login", async () => {
    registered.push(
      fakeBrain("a", { ready: true, login: "a" }),
      fakeBrain("b", { ready: true, login: "b" }),
    );
    const box = await brainBox();
    expect(box.hidden).toEqual(
      expect.arrayContaining([
        homedir(),
        dataDir(),
        "/secrets/a",
        "/secrets/b",
        expect.stringMatching(/^\/run\/user\/\d+$/u),
      ]),
    );
    expect(
      box.hidden.some((path) => import.meta.dirname.startsWith(path) && path !== homedir()),
    ).toBe(true);
    expect(box.readable).toContain(box.workDir);
  });

  it("hides the database's own files when Postgres keeps them on this machine", async () => {
    expect((await brainBox()).hidden).toContain(databaseFolder);
    // A database elsewhere (a container, another host) names a folder this machine hasn't got.
    databaseSays = "/var/lib/postgresql/data-elsewhere";
    try {
      expect((await brainBox()).hidden).not.toContain(databaseSays);
    } finally {
      databaseSays = databaseFolder;
    }
  });
});

describe("runTurn", () => {
  it("streams the answer and says which model and login it ran on", async () => {
    const { brain } = fakeBrain("a", { ready: true, login: "a" }, [
      { type: "ready", model: "opus", login: "your plan" },
      { type: "text", id: "x", delta: "Hello" },
      { type: "done" },
    ]);
    const chunks: unknown[] = [];
    const result = await runTurn({
      picked: { ...fakeBrain("a", { ready: true, login: "a" }), brain, login: "a" },
      turn,
      messageId: "m1",
      metadata: undefined,
      signal: new AbortController().signal,
      onChunk: (chunk) => void chunks.push(chunk),
    });
    expect(result).toMatchObject({ stopped: false, model: "opus", login: "your plan" });
    expect(result.error).toBeUndefined();
    expect(result.message.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: "Hello" }),
    );
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
  });

  it("keeps a usage limit and the brain's error", async () => {
    const resetsAt = new Date(clock + 10 * 60_000);
    const { brain } = fakeBrain("a", { ready: true, login: "a" }, [
      { type: "limit", resetsAt },
      { type: "error", message: "You've hit your limit" },
    ]);
    const result = await runTurn({
      picked: { ...fakeBrain("a", { ready: true, login: "a" }), brain, login: "a" },
      turn,
      messageId: "m1",
      metadata: undefined,
      signal: new AbortController().signal,
      onChunk: () => undefined,
    });
    expect(result).toMatchObject({ error: "You've hit your limit", limit: { resetsAt } });
  });
});

describe("think", () => {
  it("answers with the brain's structured output, and throws when there is none", async () => {
    const signal = new AbortController().signal;
    const answer = fakeBrain("a", { ready: true, login: "a" }, [
      { type: "done", output: { x: 1 } },
    ]);
    expect(await think({ ...answer, login: "a" }, turn, signal)).toEqual({ x: 1 });
    const failed = fakeBrain("a", { ready: true, login: "a" }, [{ type: "error", message: "no" }]);
    await expect(think({ ...failed, login: "a" }, turn, signal)).rejects.toThrow("no");
  });

  it("rests a brain that hits its usage limit, so the next ask goes elsewhere", async () => {
    const limited = fakeBrain("a", { ready: true, login: "a" }, [
      { type: "limit", resetsAt: null },
    ]);
    registered.push(limited, fakeBrain("b", { ready: true, login: "b" }));
    await expect(
      think({ ...limited, login: "a" }, turn, new AbortController().signal),
    ).rejects.toThrow(/usage limit/u);
    expect(await pickBrain()).toMatchObject({ about: { id: "b" } });
  });
});

describe("limitNotice", () => {
  it("says when the plan comes back, in the owner's time, and who answers next", async () => {
    registered.push(ready("a"), ready("b"));
    const resetsAt = new Date(clock + 2 * 60 * 60_000);
    const time = resetsAt.toLocaleTimeString("en-US", {
      timeZone: "Australia/Sydney",
      hour: "numeric",
      minute: "2-digit",
    });
    // pickBrain still gives "a" here: only a turn that hits the limit rests it.
    expect(await limitNotice(ready("b"), resetsAt, "Australia/Sydney")).toBe(
      `B has reached its usage limit until ${time}. Your next message will use A.`,
    );
    expect(await limitNotice(ready("a"), null, "UTC")).toBe(
      "A has reached its usage limit. Auni can answer again once it resets.",
    );
  });

  it("names the day when the plan comes back after tomorrow's start", async () => {
    registered.push(ready("a"));
    const notice = await limitNotice(ready("a"), new Date(clock + 3 * 24 * 60 * 60_000), "UTC");
    expect(notice).toMatch(
      /^A has reached its usage limit until (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day \d{1,2}:\d{2}\s[AP]M\. Auni can answer again then\.$/u,
    );
  });
});
