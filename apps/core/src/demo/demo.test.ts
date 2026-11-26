import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import { CARD_FORMAT, type StartingPoint } from "@auni/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sceneFor } from "./scenes.ts";
import { demoPairCode } from "./test-pair.ts";

// The demo, started as `auni demo` starts it, from an environment that names a home, a
// database, a wallet and a brain of someone's own. It must make its owner by playing every
// scene of their past through core without one refusal, and touch none of what was named.

const AUNI = fileURLToPath(new URL("../../bin/auni.mjs", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "auni-demo-test-"));

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("auni demo", () => {
  const theirs = join(scratch, "their-auni");
  let demo: ChildProcessByStdio<null, Readable, Readable>;
  let port = 0;
  let said = "";

  beforeAll(async () => {
    mkdirSync(theirs);
    // Settings that would stop a real Auni from starting at all.
    writeFileSync(join(theirs, ".env"), "DATABASE_URL=postgres://nobody@127.0.0.1:1/theirs\n");
    port = await freePort();
    demo = spawn(
      process.execPath,
      [AUNI, "demo", "--no-open", "--no-web", "--port", String(port)],
      {
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: scratch,
          AUNI_HOME: theirs,
          DATABASE_URL: "postgres://nobody@127.0.0.1:1/theirs",
          WALLET: "privy",
          BRAIN: "codex",
          RPC_URL_MONAD: "https://rpc.invalid",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    demo.stdout.on("data", (chunk: Buffer) => (said += chunk.toString()));
    demo.stderr.on("data", (chunk: Buffer) => (said += chunk.toString()));
    await vi.waitFor(
      () => {
        if (demo.exitCode !== null) throw new Error(`The demo exited:\n${said}`);
        if (!/API ready at http:\/\/\S+/u.test(said)) throw new Error(said);
      },
      { timeout: 120_000, interval: 200 },
    );
  }, 180_000);

  afterAll(async () => {
    if (demo.exitCode !== null) return;
    demo.kill("SIGTERM");
    await new Promise((exited) => demo.once("exit", exited));
  });

  it("makes its owner through core, every scene of their past without one refusal", () => {
    const log = readFileSync(
      join(scratch, `auni-demo-${userInfo().uid}-${port}`, "auni.log"),
      "utf8",
    );
    expect(said).toMatch(/^Demo mode\. Fake money only; your real data is untouched\./u);
    expect(said).toContain("Preparing sample takes.");
    expect(said).not.toContain("is held for the owner");
    expect(said).not.toContain("owner is ready");
    expect(log).not.toMatch(/which refused|has no scene for|waited a minute|no stand-in for/u);
    const [, done, waiting, failed, held] =
      /owner is ready \([\d.]+ s\): (\d+) cards done, (\d+) waiting, (\d+) failed, (\d+) held/u.exec(
        log,
      ) ?? [];
    expect(Number(done)).toBeGreaterThanOrEqual(10);
    // Four moves and an offer of an app left for the owner to tap; the one move the story has
    // fail and the held one its owner closed; and the one move left held, the only one running.
    expect(Number(waiting)).toBe(5);
    expect(Number(failed)).toBe(2);
    expect(Number(held)).toBe(1);
  });

  /** The demo's API, asked as the browser its link signed in asks it. */
  let ask: <T = unknown>(path: string, body?: unknown) => Promise<T>;
  interface Card {
    readonly id: string;
    readonly proposalId: string | null;
    readonly status: string;
    readonly phase: string | null;
  }
  const cards = async (thread: string) =>
    (await ask<{ actions: Card[] }>(`/actions?thread_id=${thread}`)).actions;
  const words = async (thread: string) => JSON.stringify(await ask(`/threads/${thread}/messages`));
  /** Waits until a thread says `said`, which may take a move landing or a watch firing. */
  const says = (thread: string, said: RegExp) =>
    expect.poll(() => words(thread), { timeout: 60_000, interval: 250 }).toMatch(said);
  /** Says `text` in a thread, as a tap on a reply does, and waits until its answer is over. */
  const say = async (thread: string, text: string) => {
    const id = randomUUID();
    await ask(`/threads/${thread}/messages`, { id, text });
    await expect
      .poll(
        async () => {
          const read = await ask<{ running: boolean; messages: { id: string; role: string }[] }>(
            `/threads/${thread}/messages`,
          );
          const said = read.messages.findIndex((message) => message.id === id);
          return !read.running && said >= 0 && read.messages.at(-1)!.role === "assistant";
        },
        { timeout: 30_000, interval: 200 },
      )
      .toBe(true);
  };
  /** Types `text` in a new chat, and waits until its turn is over: the chat's id. */
  const type = async (text: string) => {
    const { thread } = await ask<{ thread: { id: string } }>("/places/chat", { text });
    await say(thread.id, text);
    return thread.id;
  };
  /** Taps Allow on every card waiting in a thread, and waits until each has ended as `ends`. */
  const allowAll = async (thread: string, ends = "done") => {
    const waiting = (await cards(thread)).filter(({ status }) => status === "awaiting_permission");
    expect(waiting.length).toBeGreaterThan(0);
    for (const proposal of new Set(waiting.flatMap(({ proposalId }) => proposalId ?? [])))
      await ask(`/proposals/${proposal}/allow`, { cardFormat: CARD_FORMAT });
    for (const { id, proposalId } of waiting)
      if (!proposalId) await ask(`/actions/${id}/allow`, { cardFormat: CARD_FORMAT });
    const ended = async () => {
      const now = await cards(thread);
      return waiting.map(({ id }) => now.find((card) => card.id === id)?.status);
    };
    await expect
      .poll(ended, { timeout: 60_000, interval: 250 })
      .toSatisfy((statuses: string[]) => statuses.every((status) => status === ends));
  };

  it("pairs against the demo API with the web app turned off", async () => {
    const core = /API ready at (http:\/\/\S+)/u.exec(said)![1]!;
    const origin = `http://localhost:${port}`;
    expect(said).not.toContain("#pair=");
    const code = await demoPairCode(scratch, port);
    const paired = await fetch(`${core}/owner/pair`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const cookie = paired.headers.get("set-cookie")!.split(";")[0]!;
    ask = async <T = unknown>(path: string, body?: unknown): Promise<T> => {
      const answer = await fetch(`${core}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect(answer.ok, `${path} answered ${answer.status}`).toBe(true);
      return (await answer.json()) as T;
    };
    expect(await ask("/me")).toMatchObject({ name: "Sam" });
  });

  it("asks for a star, and gives it with a gh of its own, which reaches no GitHub account", async () => {
    expect(await ask("/me")).toMatchObject({ starPrompt: "ask" });
    expect(await ask("/me/star/check", {})).toEqual({ starred: false });
    expect(await ask("/me/star", {})).toEqual({ starred: true });
    expect(await ask("/me/star/check", {})).toEqual({ starred: true });
    expect(await ask("/me")).toMatchObject({ starPrompt: "answered" });
  });

  it("plays a scene typed in a new chat to a card that can be allowed, and says when it can't", async () => {
    // The plan and the short spend what the owner's past left, so they can be played again.
    const plan = await type("demo: plan");
    expect((await cards(plan)).length).toBe(2);
    await allowAll(plan);
    await allowAll(await type("demo: short"));
    // A sale on Polymarket fills against the demo's book, and its cash stays in that wallet.
    await allowAll(await type("demo: sell"));
    expect(await words(await type("demo: stop"))).toMatch(/closed your ether short/u);
    // A service Auni has no app for: the brain builds the transaction, and the card says what
    // Auni checked by running it, the brain's own sentence apart, and that no app covers it.
    // Half of the MON the wallet can spare, which leaves the tour its own stake.
    const stake = await type("Stake 50 MON with Kintsu");
    expect(await words(stake)).toMatch(
      /Checked by running it first.*Not checked: what Auni says about it.*No app for Kintsu yet/su,
    );
    await allowAll(stake);
    // Its landing tells the brain no app covers it, and the brain offers to ask for one: a
    // card of what the owner could post, which core built and sealed.
    await expect
      .poll(() => words(stake), { timeout: 30_000, interval: 250 })
      .toMatch(/"kind":"feedback".*App request: Kintsu/su);
    // Unstaking sends with nothing back, so it takes the owner's proof, and its card carries no note.
    const unstake = await words(await type("demo: unstake"));
    expect(unstake).toMatch(/"takesProof":true/u);
    expect(unstake).toMatch(/Nothing back.*No app for Kintsu yet/su);
    expect(unstake).not.toMatch(/Not checked/u);

    // A sale Polymarket never answers is held: the brain is woken once and says so, Check
    // again finds nothing new, and Close ends it as closed by the owner, with nothing sold.
    const unheard = await type("demo: held");
    const [sale] = await cards(unheard);
    await ask(`/actions/${sale!.id}/allow`, { cardFormat: CARD_FORMAT });
    const phase = async () => (await cards(unheard))[0]?.phase;
    await expect.poll(phase, { timeout: 60_000, interval: 250 }).toBe("needs_owner");
    await says(unheard, /most likely never went in.*close that card/su);
    expect(await ask(`/actions/${sale!.id}/check`, {})).toMatchObject({
      action: { phase: "needs_owner", error: expect.stringContaining("never heard back") },
    });
    expect(await ask(`/actions/${sale!.id}/close`, {})).toMatchObject({
      action: { status: "failed", failureKind: "sent", run: { settledBy: "owner" } },
    });
    await says(unheard, /Closed\. Your Fed position is as it was/u);

    // A scene whose tool refuses (closing a sliver is below Hyperliquid's minimum) says what
    // Auni answered, rather than speak of a card that isn't there.
    const again = await type("Take a sliver of my bitcoin long");
    expect(await cards(again)).toEqual([]);
    expect(await words(again)).toMatch(/wouldn't make that card/u);
  }, 180_000);

  it("takes off the table the cards a new one stands in for, and takes back one Auni no longer stands behind", async () => {
    // Two cards, then one for both that names them: only it is left to tap.
    const both = await type("Nvidia and Tesla on one card");
    const statuses = async () => (await cards(both)).map(({ status }) => status).sort();
    expect(await statuses()).toEqual([
      "awaiting_permission",
      "awaiting_permission",
      "replaced",
      "replaced",
    ]);
    // From another chat, the card is taken back by its id, which the turn's context gives.
    expect(await words(await type("I no longer want the Nvidia buy"))).toMatch(
      /taken that Nvidia card back/u,
    );
    expect(await statuses()).toEqual(["replaced", "replaced", "retracted", "retracted"]);
  });

  it("walks its tour from the first stop to the last, by tapping the reply each stop docks", async () => {
    const stop = (number: number) => new RegExp(`Stop ${number} of \\d+\\. `, "u");
    /** The first answer of the question a thread's latest words asked: the reply to tap. */
    const docked = async (thread: string) => {
      const { messages } = await ask<{
        messages: { parts: { type: string; input?: { options: { label: string }[] } }[] }[];
      }>(`/threads/${thread}/messages`);
      const asked = messages.at(-1)!.parts.findLast(({ type }) => type === "tool-suggest_replies");
      return asked!.input!.options[0]!.label;
    };
    const tap = async (thread: string) => say(thread, await docked(thread));
    /** What the demo had said before the tour began. */
    const began = said.length;

    // A new chat's first starting point is the tour, and its prompt starts it. Another wears
    // the picture of the market it is about, as Polymarket publishes it.
    const { points } = await vi.waitFor(
      async () => {
        const read = await ask<{ points: StartingPoint[] }>("/starting-points");
        expect(read.points.length).toBeGreaterThan(0);
        return read;
      },
      { timeout: 30_000, interval: 250 },
    );
    expect(points[0]).toMatchObject({ action: "Take the tour", image: null });
    expect(points.map(({ image }) => image)).toContainEqual(
      expect.stringMatching(/^https:\/\/polymarket-upload\./u),
    );
    const tour = await type(points[0]!.prompt);
    await says(tour, stop(1));

    // A view said, looked into, and proposed straight onto one plan card in the same thread.
    await tap(tour);
    await says(tour, stop(2));
    expect(await words(tour)).toMatch(/"tool-find_instruments".*Eli Lilly.*Novo Nordisk/su);
    await allowAll(tour);
    await says(tour, stop(3));
    await tap(tour);
    await says(tour, stop(4));

    // A watch, which the demo's Solana trips a few seconds on: Auni speaks up unasked.
    await tap(tour);
    await says(tour, /Solana just dropped/u);
    await says(tour, stop(5));

    // A move that fails once allowed, and says so.
    await tap(tour);
    await allowAll(tour, "failed");
    await says(tour, stop(6));

    // A service no app covers, on the card of a transaction the brain built; landed, Auni
    // offers to ask for an app, which is the next stop.
    await tap(tour);
    await allowAll(tour);
    await says(tour, stop(7));
    await tap(tour);
    await says(tour, stop(8));

    // An app offered for the key it needs, and declined.
    await tap(tour);
    const offer = (await cards(tour)).find(({ status }) => status === "awaiting_permission")!;
    await ask(`/actions/${offer.id}/decline`, {});
    await says(tour, stop(9));

    // The last three are places to look, and then it is over.
    for (const next of [10, 11, 12]) {
      await tap(tour);
      await says(tour, stop(next));
    }
    await tap(tour);
    await says(tour, /That is the tour\./u);
    // It ends on things to try next, and answers the one tapped. Anything else said after it
    // is over is answered as in any chat, with no reply docked.
    await tap(tour);
    await says(tour, /Needs you/u);
    // Docked again are only those not asked yet, so the next tap is never the same question.
    expect(await docked(tour)).toBe("Show me an Auto thread");
    await tap(tour);
    await says(tour, /AI buildout/u);
    expect(await docked(tour)).toBe("How do I run it for real?");
    await say(tour, "demo: funding");
    await expect(docked(tour)).rejects.toThrow();

    // A second tour, left by its other door: the plan card turned down. Nothing was
    // bought, so the tour passes the stop that shows the panel and carries on at the watch.
    const second = await type(points[0]!.prompt);
    await tap(second);
    await says(second, stop(2));
    const [plan] = (await cards(second)).filter(({ status }) => status === "awaiting_permission");
    await ask(`/proposals/${plan!.proposalId}/decline`, {});
    await says(second, stop(4));
    expect(await words(second)).toMatch(/Nothing was bought/u);
    expect(await words(second)).not.toMatch(stop(3));
    expect(said.slice(began)).not.toMatch(/which refused|has no scene for/u);
  }, 300_000);

  it("touches nothing the environment names, and leaves nothing behind", async () => {
    demo.kill("SIGTERM");
    await new Promise((exited) => demo.once("exit", exited));
    expect(readdirSync(theirs)).toEqual([".env"]);
    expect(existsSync(join(scratch, `auni-demo-${userInfo().uid}-${port}`))).toBe(false);
  });
});

describe("the demo's brain", () => {
  const sceneNamed = (heard: string) => sceneFor(heard).name;

  it("plays a scene by its name, by the owner's words, and by the event that woke it", () => {
    expect(sceneNamed("demo: plan")).toBe(sceneNamed("I want to go long bitcoin."));
    expect(sceneNamed("demo: plan")).not.toBe("plain");
    expect(
      sceneNamed(
        "Nothing new from the owner. Background event: Action 1 (Buy about $400 of Coinbase xStock) finished as failed: it reverted",
      ),
    ).toBe(sceneNamed("demo: settled"));
    // A move just held, and one its owner then closed, each have words of their own.
    expect(
      sceneNamed("Background event: Action 1 (Sell 40 Yes shares) is held. Auni sent it and never"),
    ).toBe("held-told");
    expect(
      sceneNamed(
        "Background event: Action 1 (Sell 40 Yes shares) finished as failed: You closed it before Auni could tell whether it went through.",
      ),
    ).toBe("closed");
  });

  it("says what it can show when it knows no scene", () => {
    expect(sceneNamed("What is the weather?")).toBe("plain");
    expect(sceneNamed("demo: nothing-by-this-name")).toBe("plain");
  });
});
