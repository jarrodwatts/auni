import { Agent, createServer, request } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { keepIdleConnections } from "./server.ts";

/** One GET down the agent's connections, answering whether it was a connection already open. */
function get(agent: Agent, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const asked = request({ port, agent, path: "/" }, (answer) => {
      answer.resume();
      answer.on("end", () => resolve(asked.reusedSocket));
    });
    asked.on("error", reject);
    asked.end();
  });
}

describe("core's API", () => {
  // Next's proxy keeps connections to core with no time limit of its own and reuses them.
  it("leaves a connection idle past Node's own limit open for its client", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    keepIdleConnections(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const agent = new Agent({ keepAlive: true });
    try {
      expect(await get(agent, port)).toBe(false);
      // Node closes an idle connection after five seconds, and a second more of grace.
      await new Promise((resolve) => setTimeout(resolve, 6_500));
      expect(await get(agent, port)).toBe(true);
    } finally {
      agent.destroy();
      server.closeAllConnections();
      server.close();
    }
  }, 15_000);
});
