import "../../agent/live-env.ts";

import { writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { liveCore, liveScenario, redactor } from "../../agent/live.ts";
import auni from "./index.ts";
import type { WireLine } from "./app-server.ts";
import { runCodex } from "./run.ts";

// Records one real turn of the owner's own Codex as a replay fixture (fixtures/<scenario>.jsonl),
// both directions of the wire, by hand, never in CI: it spends the owner's plan. Run with
//   TEST_DATABASE_URL=postgres://…/<name>_test pnpm --filter @auni/core exec node src/apps/codex/record.ts <scenario>
// with core's API not running (this starts one of its own on a test database).

const scenario = process.argv[2];
const live = await liveCore();
const turn = await liveScenario(scenario, live, auni.brain!);

const redact = redactor(live, homedir());
/** What core asked, by request id, so a reply can be cut by what it answers. */
const asked = new Map<number | string, string>();
/**
 * Keeps only what the replay reads. Two replies carry the owner's own setup: config/read (their
 * whole config, with every file in home the box denies) and model/list (their plan's catalogue).
 * run.ts's othersOff reads only the MCP servers' ids, and defaultModel the default model.
 * The system prompt is core's own and long; the fixture is about the wire.
 */
const shorter = (line: WireLine): WireLine => {
  const { message } = line;
  if (line.from === "core" && message.method && message.id !== undefined)
    asked.set(message.id, message.method);
  if (line.from === "codex" && message.id !== undefined && !message.method) {
    const method = asked.get(message.id);
    if (method === "config/read") {
      const { config } = message.result as { config: { mcp_servers?: object | null } };
      const ids = Object.keys(config.mcp_servers ?? {});
      const mcp_servers = Object.fromEntries(ids.map((id) => [id, {}]));
      return { ...line, message: { ...message, result: { config: { mcp_servers } } } };
    }
    if (method === "model/list") {
      const { data } = message.result as { data: { isDefault?: boolean }[] };
      const chosen = data.find((model) => model.isDefault) ?? data[0];
      const result = { data: chosen ? [chosen] : [], nextCursor: null };
      return { ...line, message: { ...message, result } };
    }
  }
  const params = message.params as { baseInstructions?: string } | undefined;
  return params?.baseInstructions
    ? {
        ...line,
        message: { ...line.message, params: { ...params, baseInstructions: "<system prompt>" } },
      }
    : line;
};
const lines: string[] = [];
const started = Date.now();
for await (const event of runCodex(turn, AbortSignal.timeout(180_000), {
  onLine: (line) => lines.push(redact(JSON.stringify(shorter(line)))),
})) {
  if (event.type === "ready") console.log(`ready in ${Date.now() - started} ms: ${event.model}`);
  if (event.type === "tool-call") console.log(`> ${event.name} ${JSON.stringify(event.input)}`);
  if (event.type === "done" || event.type === "error") console.log(JSON.stringify(event));
}
const path = new URL(`fixtures/${scenario}.jsonl`, import.meta.url);
writeFileSync(path, `${lines.join("\n")}\n`);
console.log(`recorded ${lines.length} lines in ${Date.now() - started} ms to ${path.pathname}`);
await live.close();
process.exit(0);
