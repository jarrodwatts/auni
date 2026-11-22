import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

async function loadEnv(vars: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value);
  return (await import("./env.ts")).env;
}

describe("env", () => {
  // The first import of env.ts loads what it imports, which on a busy machine takes longer than
  // a test may: load it once before timing any test, so each test times only its own read.
  beforeAll(() => import("./env.ts"), 60_000);
  afterEach(() => vi.unstubAllEnvs());

  it("reads an empty optional key as unset", async () => {
    expect((await loadEnv({ ALCHEMY_API_KEY: "" })).ALCHEMY_API_KEY).toBeUndefined();
  });

  it("finds the web app on this machine at WEB_PORT unless WEB_ORIGIN says otherwise", async () => {
    expect((await loadEnv({ WEB_ORIGIN: "", WEB_PORT: "3311" })).WEB_ORIGIN).toBe(
      "http://localhost:3311",
    );
    expect((await loadEnv({ WEB_ORIGIN: "https://auni.example/" })).WEB_ORIGIN).toBe(
      "https://auni.example",
    );
  });

  it("takes a Tailscale owner only with this machine's https address on the tailnet", async () => {
    const at = "https://box.tailnet-example.ts.net";
    expect(
      (await loadEnv({ TAILSCALE_OWNER: "owner@example.com", WEB_ORIGIN: at })).TAILSCALE_OWNER,
    ).toBe("owner@example.com");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const origin of ["", "http://box.tailnet-example.ts.net"])
      await expect(
        loadEnv({ TAILSCALE_OWNER: "owner@example.com", WEB_ORIGIN: origin }),
      ).rejects.toThrow(/process\.exit/u);
  });

  it("keeps each chain's own RPC by its network, and refuses one that isn't a URL", async () => {
    expect(
      (await loadEnv({ RPC_URL_MONAD: "http://127.0.0.1:8545", RPC_URL_BASE: "" })).RPC_URLS,
    ).toEqual({ monad: "http://127.0.0.1:8545" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(loadEnv({ RPC_URL_SOLANA: "solana" })).rejects.toThrow(/process\.exit/u);
  });
});
