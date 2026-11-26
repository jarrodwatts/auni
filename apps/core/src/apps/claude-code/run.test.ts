import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { tempDir } from "../../test/temp-dir.ts";
import type { Box } from "../../agent/box.ts";
import type { BrainTurn } from "../contract.ts";

// The CLI itself never runs: query stands in, seeing what the CLI would.
const seen = vi.hoisted(() => ({ file: "", mode: 0, config: "", argv: "" }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Options }): AsyncIterable<SDKMessage> => ({
    [Symbol.asyncIterator]: () => ({
      next: () => {
        seen.file = options.extraArgs?.["mcp-config"] ?? "";
        seen.mode = statSync(seen.file).mode & 0o777;
        seen.config = readFileSync(seen.file, "utf8");
        // Everything the SDK could turn into the CLI's command line.
        seen.argv = JSON.stringify(options);
        return Promise.reject(new Error("the CLI exited"));
      },
    }),
  }),
}));

const { claudeFrames } = await import("./run.ts");

const data = tempDir("auni-mcp-", afterAll);
const before = process.env.AUNI_HOME;
beforeAll(() => {
  process.env.AUNI_HOME = data;
});
afterAll(() => {
  if (before === undefined) delete process.env.AUNI_HOME;
  else process.env.AUNI_HOME = before;
});

const box: Box = { workDir: "/home/owner/.auni-work", hidden: [], readable: [] };
const turn: BrainTurn = {
  systemPrompt: "You are Auni.",
  prompt: ["Hi"],
  role: "everyday",
  box,
  mcp: { url: "http://127.0.0.1:4000/mcp", token: "the-turn-token" },
};

describe("the turn's MCP config", () => {
  it("lives in a 0600 file in the data folder while the CLI runs, and is gone after", async () => {
    const frames = claudeFrames(turn, new AbortController().signal);
    await expect(
      (async () => {
        for await (const frame of frames) void frame;
      })(),
    ).rejects.toThrow(/Claude Code stopped: the CLI exited/u);

    expect(seen.file.startsWith(join(data, "run", "mcp-"))).toBe(true);
    expect(seen.mode).toBe(0o600);
    expect(JSON.parse(seen.config)).toMatchObject({
      mcpServers: { auni: { headers: { authorization: "Bearer the-turn-token" } } },
    });
    expect(seen.argv).not.toContain("the-turn-token");
    expect(existsSync(seen.file)).toBe(false);
    expect(readdirSync(join(data, "run"))).toEqual([]);
  });
});
