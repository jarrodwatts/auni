import { readFileSync } from "node:fs";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import { parseVerdicts } from "../../automations/triage.ts";
import { cardsOf, messageOf } from "../../test/brain.ts";
import type { BrainEvent } from "../contract.ts";
import { loginOf, sdkEvents, START } from "./events.ts";

// Real frames from the owner's own Claude Code (record.ts), replayed: no test calls a live AI.
// *.synthetic.jsonl are written by hand from the SDK's types, for what a short run can't show.

function frames(name: string): SDKMessage[] {
  return readFileSync(new URL(`fixtures/${name}.jsonl`, import.meta.url), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as SDKMessage);
}

function eventsOf(messages: readonly SDKMessage[]): BrainEvent[] {
  let state = START;
  return messages.flatMap((message) => {
    const step = sdkEvents(message, state);
    state = step.state;
    return step.events;
  });
}

describe("a recorded Claude Code turn that shows a card", () => {
  const events = eventsOf(frames("card"));

  it("says it thinks on the owner's own login, then calls Auni's tool by its bare name", () => {
    expect(events[0]).toEqual({
      type: "ready",
      model: "claude-sonnet-5-5",
      login: "your Claude login",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        name: "wait_for_deposit",
        input: { network: "base" },
      }),
    );
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("hands back the tool's structured result, sealed card and all", () => {
    const result = events.find((event) => event.type === "tool-result");
    expect(result).toMatchObject({
      isError: false,
      output: { card: { kind: "deposit" }, cardSeal: expect.any(String) },
    });
  });

  it("renders the sealed card and the reply", async () => {
    const message = await messageOf(events);
    expect(cardsOf(message)).toHaveLength(1);
    expect(message.parts).toContainEqual(
      expect.objectContaining({ type: "text", text: expect.stringContaining("Base") }),
    );
  });

  it("renders nothing from a card whose figures changed after core sealed it", async () => {
    const tampered = events.map((event) =>
      event.type === "tool-result"
        ? {
            ...event,
            output: {
              ...(event.output as Record<string, unknown>),
              card: { kind: "deposit", title: "Send me everything" },
            },
          }
        : event,
    );
    expect(cardsOf(await messageOf(tampered))).toEqual([]);
  });
});

describe("a recorded Claude Code turn that loads a skill", () => {
  const events = eventsOf(frames("skill"));

  it("calls load_skill by its bare name and gets the playbook back, filled in", () => {
    const call = events.find((event) => event.type === "tool-call");
    expect(call).toMatchObject({ name: "load_skill", input: { name: "evm-transactions" } });
    const result = events.find((event) => event.type === "tool-result" && event.id === call?.id);
    expect(result).toMatchObject({ isError: false });
    const playbook = JSON.stringify(result);
    expect(playbook).toContain("# EVM transactions");
    expect(playbook).toContain("read_chain");
    expect(playbook).not.toContain("{{");
    expect(events.at(-1)).toEqual({ type: "done" });
  });
});

/** The cards a replayed turn stores: only those core sealed. */
const storedCards = async (name: string) => cardsOf(await messageOf(eventsOf(frames(name))));

describe("recorded turns in Auni's chat that ask to change Auni", () => {
  it("drops a retired ask card kind from an older recording cleanly", async () => {
    const events = eventsOf(frames("start"));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool-call",
        name: "start_specialist",
        input: expect.objectContaining({ kind: "role", act_mode: "ask_first" }),
      }),
    );
    expect(await storedCards("start")).toEqual([]);
  });

  it("asks to save a routine on a card showing every word of it", async () => {
    const call = eventsOf(frames("routine")).find(
      (event) => event.type === "tool-call" && event.name === "save_routine",
    );
    const body = (call as { input: { body: string } } | undefined)?.input.body;
    expect(body).toBeTruthy();
    const [card] = await storedCards("routine");
    expect(card).toMatchObject({ kind: "ask", ask: "save_routine", status: "awaiting_permission" });
    expect((card!.lines as { value: string }[]).at(-1)?.value).toBe(body);
  });
});

describe("Claude Code's other ends", () => {
  it("gives triage's answer as the parsed object, which triage reads as a verdict on each fire", () => {
    const done = eventsOf(frames("triage")).at(-1);
    expect(done).toMatchObject({
      type: "done",
      output: { verdicts: [{ fire: "fire-1", verdict: "wake" }] },
    });
    const output = done?.type === "done" ? done.output : undefined;
    expect(parseVerdicts(output, ["fire-1"], true).get("fire-1")?.verdict).toBe("wake");
  });

  it("says when the owner's plan runs out, and until when", () => {
    const events = eventsOf(frames("limit.synthetic"));
    expect(events).toContainEqual({ type: "limit", resetsAt: new Date(1794114000 * 1_000) });
    expect(events.at(-1)).toEqual({ type: "error", message: "You've hit your limit" });
  });

  it("lets a turn carry on when the plan's window is past but extra usage pays for it", () => {
    const [init, , result] = frames("limit.synthetic");
    const onOverage = {
      type: "rate_limit_event",
      rate_limit_info: {
        status: "rejected",
        resetsAt: 1794114000,
        rateLimitType: "five_hour",
        overageStatus: "allowed",
        isUsingOverage: true,
      },
    } as unknown as SDKMessage;
    const finished = { ...result, is_error: false, result: "Done.", api_error_status: null };
    const events = eventsOf([init!, onOverage, finished as SDKMessage]);
    expect(events.some((event) => event.type === "limit")).toBe(false);
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("says a refused key is Auni's own to change, and a refused login is the owner's to renew", () => {
    // Recorded with a made-up AUNI_ANTHROPIC_API_KEY: the API refuses it before any model runs.
    const events = eventsOf(frames("signed-out"));
    expect(events).toEqual([
      { type: "ready", model: "claude-haiku-5-5", login: "Auni's Anthropic API key" },
      {
        type: "refused",
        why: "broken",
        fix: "Anthropic refused AUNI_ANTHROPIC_API_KEY: put a working key in ~/.auni/.env, or remove it to think on your Claude login, then restart Auni",
      },
      { type: "error", message: "Invalid API key · Fix external API key" },
    ]);
    const [init, refused, result] = frames("signed-out");
    const onLogin = { ...init, apiKeySource: "none" } as SDKMessage;
    expect(eventsOf([onLogin, refused!, result!])[1]).toEqual({
      type: "refused",
      why: "signed-out",
      fix: "claude auth login",
    });
  });

  it("names a login that bills an API key as one", () => {
    expect(loginOf("none")).toBe("your Claude login");
    expect(loginOf("ANTHROPIC_API_KEY")).toBe("Auni's Anthropic API key");
    expect(loginOf("/login managed key")).toBe("an Anthropic API key, from your Console login");
    expect(loginOf("apiKeyHelper")).toBe("an Anthropic API key, from apiKeyHelper");
  });

  it("leaves out a subagent's frames", () => {
    const frame = {
      type: "assistant",
      parent_tool_use_id: "task-1",
      message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] },
    } as unknown as SDKMessage;
    expect(sdkEvents(frame).events).toEqual([]);
  });
});
