import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { BrainEvent } from "../apps/contract.ts";
import type { Stage } from "./brain.ts";
import { sceneFor } from "./scenes.ts";
import { tour } from "./tour.ts";

// The tour's own rules, played with no demo running: where a thread stands is read from the
// thread, a reply is always docked in its chat, and nothing of it reaches a real Auni.
// `demo.test.ts` walks every stop of it through core.

/** What one turn said and docked, played over a scene that says "(the scene)". */
async function play(heard: string, before: readonly string[] = [], refuses = false) {
  const said: string[] = [];
  const replies: string[][] = [];
  const text = (delta: string): BrainEvent => ({ type: "text", id: "text", delta });
  const stage: Stage = {
    heard,
    before,
    context: "",
    async *think() {},
    async *say(words) {
      said.push(words);
      yield text(words);
    },
    async *call(name, input) {
      if (name === "suggest_replies")
        replies.push((input.options as { label: string }[]).map(({ label }) => label));
      yield { type: "tool-call", id: "call", name, input };
      return "";
    },
  };
  const scene = async function* ({ say }: Stage): AsyncGenerator<BrainEvent, boolean> {
    yield* say("(the scene)");
    return !refuses;
  };
  for await (const event of tour(stage, scene)) void event;
  return { said: said.join("\n"), replies: replies.at(-1) };
}

/** A thread as a brain is told it: the owner's words and Auni's, a block each. */
const thread = (...turns: readonly (readonly [said: string, answered: string])[]) =>
  turns.flatMap(([said, answered]) => [`User: ${said}`, `Auni: ${answered}`]);

describe("the tour", () => {
  it("starts as a new chat's first words, and never in the middle of another", async () => {
    const started = await play("Take the tour");
    expect(started.said).toMatch(/^Welcome\..*Stop 1 of \d+\. /su);
    expect(started.said).not.toContain("(the scene)");
    expect(started.replies).toHaveLength(2);
    expect(
      await play("Take the tour", thread(["How am I doing?", "You're in good shape."])),
    ).toEqual({ said: "(the scene)", replies: undefined });
  });

  it("leaves a thread that is not on it to its scene", async () => {
    expect(await play("Buy $250 of Nvidia.")).toEqual({ said: "(the scene)", replies: undefined });
  });

  it("keeps its place in the chat itself, stop by stop to its end, each reply one a scene plays", async () => {
    const turns: (readonly [string, string])[] = [];
    let last = await play("Take the tour");
    const stops: string[] = [];
    for (;;) {
      const [, number, of] = /Stop (\d+) of (\d+)\. /u.exec(last.said) ?? [];
      if (!number) break;
      stops.push(number);
      expect(Number(of)).toBeGreaterThanOrEqual(10);
      // What is docked is something an owner would say, which a scene answers, or what they
      // saw where the stop sent them; either fits a reply's forty characters. A stop whose
      // doing is a card on the screen docks nothing.
      const [reply, skip = "Skip"] = last.replies ?? [];
      expect((reply ?? "").length).toBeLessThanOrEqual(40);
      const looked = await play(reply ?? skip, thread(...turns, ["Take the tour", last.said]));
      if (reply && looked.said.includes("(the scene)"))
        expect(sceneFor(reply).name).not.toBe("plain");
      turns.push([turns.length === 0 ? "Take the tour" : skip, last.said]);
      last = await play(skip, thread(...turns));
    }
    // Every stop that needs nothing a stop before it left on the screen, in order.
    expect(stops.length).toBeGreaterThanOrEqual(8);
    expect(stops).toEqual(stops.toSorted((a, b) => Number(a) - Number(b)));
    expect(last.said).toMatch(/That is the tour\./u);
    // It ends on things to try next, each of which it answers itself, offering those not asked.
    expect(last.replies).toHaveLength(3);
    turns.push(["Skip", last.said]);
    for (const next of last.replies!) {
      const answered = await play(next, thread(...turns));
      expect(answered.said).not.toContain("(the scene)");
      expect(answered.replies).toEqual(last.replies!.filter((reply) => reply !== next));
    }
    // One asked before is not offered again; with all asked, nothing is docked.
    const [first, second, third] = last.replies!;
    const asked = thread(...turns, [first!, "(answered)"], [second!, "(answered)"]);
    expect((await play(third!, asked)).replies).toBeUndefined();
    // Over, its chat is otherwise a chat like any other.
    expect(await play("How am I doing?", thread(...turns))).toEqual({
      said: "(the scene)",
      replies: undefined,
    });
  });

  it("skips past the stops that speak of what the skipped one would have left on the screen", async () => {
    const started = await play("Take the tour");
    // With no belief said there is no research and no specialist, so no stop 2, 3 or 4.
    const skipped = await play("Skip", thread(["Take the tour", started.said]));
    expect(skipped.said).toMatch(/^\*\*Stop 5 of/u);
    // Looked at, a stop is followed by the next one, whatever that speaks of.
    const at = (stop: number) => thread(["Take the tour", `**Stop ${stop} of 13. A stop**`]);
    // Anything else said at a stop docks its reply again, which is how this reads stop 8's.
    const seen = (await play("How am I doing?", at(8))).replies![0]!;
    expect((await play(seen, at(8))).said).toMatch(/^\*\*Stop 9 of/u);
    expect((await play("Skip", at(7))).said).toMatch(/^\*\*Stop 9 of/u);
    expect((await play("Skip", at(9))).said).toMatch(/^\*\*Stop 10 of/u);
  });

  it("goes on from an app's card whichever way it was answered", async () => {
    const at = thread(["Take the tour", "**Stop 9 of 13. I offer an app**"]);
    const woken = (event: string) => `Nothing new from the owner. Background event: ${event}`;
    for (const event of [
      "The owner declined action 1 (Jupiter API key).",
      "The owner saved their Jupiter API key, which your card asked for.",
    ])
      expect((await play(woken(event), at)).said).toMatch(/^\(the scene\)\n\*\*Stop 10 of/u);
  });

  it("answers anything else said in its chat, and docks the stop's reply again", async () => {
    const started = await play("Take the tour");
    const aside = await play("How am I doing?", thread(["Take the tour", started.said]));
    expect(aside.said).toBe("(the scene)");
    expect(aside.replies).toEqual(started.replies);
  });

  it("says nothing of a scene a tool cut short, and docks the stop's reply again", async () => {
    const started = await play("Take the tour");
    const [reply] = started.replies!;
    const before = thread(["Take the tour", started.said]);
    expect((await play(reply!, before)).said).toMatch(/^\(the scene\)\n\*\*Stop 2 of/u);
    expect(await play(reply!, before, true)).toEqual({
      said: "(the scene)",
      replies: started.replies,
    });
  });

  it("docks nothing in a thread it only passes through", async () => {
    const passing = [
      "(Background: The owner just started you.)\nAuni: I'm on it.\n**Stop 3 of 13. The plan card**",
    ];
    expect(await play("Add something to it.", passing)).toEqual({
      said: "(the scene)",
      replies: undefined,
    });
  });
});

describe("a real Auni", () => {
  const SRC = fileURLToPath(new URL("..", import.meta.url));
  const REPO = join(SRC, "../../..");
  const sources = (folder: string): string[] =>
    readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
      const path = join(folder, entry.name);
      if (entry.isDirectory())
        return ["node_modules", ".next", "demo"].includes(entry.name) ? [] : sources(path);
      return /\.(ts|tsx|md|css)$/u.test(entry.name) ? [path] : [];
    });

  it("loads the demo's folder from one place only, the `demo` command", () => {
    const demo = join(SRC, "demo");
    const loads = sources(SRC).flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/(?:from|import\(?)\s*["'](\.[^"']*)["']/gu)]
        .filter(([, from]) => !relative(demo, resolve(dirname(path), from!)).startsWith(".."))
        .map(([, from]) => `${relative(SRC, path)} loads ${from}`),
    );
    expect(loads).toEqual(["cli.ts loads ./demo/start.ts"]);
    const cli = readFileSync(join(SRC, "cli.ts"), "utf8");
    const command = cli.slice(cli.indexOf('case "demo":'), cli.indexOf("./demo/start.ts"));
    // The import sits in the `demo` command's own case, with no other case begun before it.
    expect(command).toMatch(/^case "demo":/u);
    expect(command).not.toMatch(/\n\s*case "/u);
  });

  it("holds no word of the tour: not in core outside the demo, the web app or what they share", () => {
    const said = [SRC, join(REPO, "apps/web"), join(REPO, "packages/shared/src")]
      .flatMap(sources)
      .filter((path) => /\btour\b/iu.test(readFileSync(path, "utf8")))
      .map((path) => relative(REPO, path));
    expect(said).toEqual([]);
  });
});
