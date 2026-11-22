import "../../agent/live-env.ts";

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { liveCore, liveScenario, redactor } from "../../agent/live.ts";
import auni from "./index.ts";
import { claudeFrames } from "./run.ts";

// Records one real turn of the owner's own Claude Code as a replay fixture (fixtures/<scenario>.jsonl),
// by hand, never in CI: it spends the owner's subscription. Run with
//   TEST_DATABASE_URL=postgres://…/<name>_test pnpm --filter @auni/core exec node src/apps/claude-code/record.ts <scenario>
// with core's API not running (this starts one of its own on a test database).

const scenario = process.argv[2];
const live = await liveCore();
const turn = await liveScenario(scenario, live, auni.brain!);

const redact = redactor(live, homedir());
/**
 * Keeps only what the replay reads. The init frame also lists the CLI's skills, commands, plugins
 * and its memory folder in home; the replay reads only its model and how the turn is billed.
 */
const shorter = (frame: SDKMessage): object =>
  frame.type === "system" && frame.subtype === "init"
    ? {
        type: frame.type,
        subtype: frame.subtype,
        model: frame.model,
        apiKeySource: frame.apiKeySource,
        session_id: frame.session_id,
        uuid: frame.uuid,
      }
    : frame;
const lines: string[] = [];
const started = Date.now();
for await (const frame of claudeFrames(turn, AbortSignal.timeout(180_000)))
  lines.push(redact(JSON.stringify(shorter(frame))));
const path = new URL(`fixtures/${scenario}.jsonl`, import.meta.url);
writeFileSync(path, `${lines.join("\n")}\n`);
console.log(`recorded ${lines.length} frames in ${Date.now() - started} ms to ${path.pathname}`);
await live.close();
process.exit(0);
