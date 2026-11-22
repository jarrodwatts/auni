import { HttpRequestError } from "viem";
import { describe, expect, it, vi } from "vitest";

import { failure } from "./agent/tool.ts";
import { errorWords } from "./safe-words.ts";

vi.mock("./env.ts", () => ({
  env: {
    ALCHEMY_API_KEY: "alchemy-key-0123456789",
    TURN_TOKEN_SECRET: "t".repeat(32),
    DATABASE_URL: "postgres://auni:db-password-99@localhost:5432/auni",
    RPC_URLS: { monad: "https://rpc.example/v2/SECRETKEY123?apikey=QUERYKEY456" },
  },
}));

describe("an error as the agent and the owner are told it", () => {
  // As viem's own transport words a node that answered 500.
  const fromViem = new HttpRequestError({
    url: "https://rpc.example/v2/SECRETKEY123?apikey=QUERYKEY456",
    status: 500,
    body: { method: "eth_getTransactionReceipt", params: ["0xabc"] },
  });

  it("names the host it called, never the path or query that can carry a key", () => {
    expect(fromViem.message).toContain("SECRETKEY123");
    const told = errorWords(fromViem);
    expect(told).toContain("URL: rpc.example");
    expect(told).toContain("Status: 500");
    expect(told).not.toMatch(/SECRETKEY123|QUERYKEY456/u);
    // The same however it is written: escaped in JSON, or with no scheme.
    expect(errorWords('{"url":"https:\\/\\/rpc.example\\/v2\\/SECRETKEY123"}')).not.toContain(
      "SECRETKEY123",
    );
    expect(errorWords("rpc.example/v2/SECRETKEY123 refused")).toBe("rpc.example refused");
    // What follows a link is the sentence's.
    expect(errorWords("Couldn't fetch http://127.0.0.1:1/v2/KEY: refused.")).toBe(
      "Couldn't fetch 127.0.0.1: refused.",
    );
  });

  it("takes out each of core's own secrets, quoted alone in any case", () => {
    const told = errorWords(
      new Error(
        "Bad key ALCHEMY-KEY-0123456789; path SECRETKEY123; password db-password-99; sig " +
          "t".repeat(32),
      ),
    );
    expect(told).toBe("Bad key …; path …; password …; sig …");
  });

  it("is what a tool that failed tells the agent", () => {
    const [content] = failure(fromViem).content;
    expect(content).toMatchObject({ type: "text" });
    expect(JSON.stringify(content)).not.toContain("SECRETKEY123");
  });
});
