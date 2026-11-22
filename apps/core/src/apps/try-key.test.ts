import { afterEach, describe, expect, it, vi } from "vitest";

import type { App } from "./contract.ts";
import elfa from "./elfa/index.ts";
import jupiter from "./jupiter/index.ts";
import polymarket from "./polymarket/index.ts";
import { apps } from "./registry.ts";
import relay from "./relay/index.ts";
import telegram from "./telegram/index.ts";

// Each service's answer to a made-up key, as it answered on 2026-11-13 at the call its key is
// tried with, and its answer to a good one, as its documentation shows it.
const ANSWERS = {
  elfa: {
    asks: "https://api.elfa.ai/v3/key-status",
    took: [200, { plan: "payg", scopes: ["key-status"], credits: { remaining: 2223 } }],
    refused: [401, { code: "ERR_UNAUTHORIZED", message: "Invalid or expired API key" }],
  },
  telegram: {
    asks: "https://api.telegram.org/botTYPED/getMe",
    took: [200, { ok: true, result: { id: 1, is_bot: true, username: "my_auni_bot" } }],
    refused: [401, { ok: false, error_code: 401, description: "Unauthorized" }],
  },
  jupiter: {
    asks: "https://api.jup.ag/tokens/v2/search?query=So11111111111111111111111111111111111111112",
    took: [200, [{ id: "So11111111111111111111111111111111111111112", symbol: "SOL" }]],
    refused: [401, { code: 401, message: "Unauthorized" }],
  },
  relay: {
    asks: "https://api.relay.link/metrics/usage",
    took: [200, { usage: [] }],
    refused: [401, { message: "Unauthorized: Check API Key" }],
  },
  polymarket: {
    asks: "https://relayer-v2.polymarket.com/transactions",
    took: [200, []],
    refused: [401, { error: "invalid authorization" }],
  },
} as const;

const TRIED: Readonly<Record<keyof typeof ANSWERS, readonly [App, string]>> = {
  elfa: [elfa, "apiKey"],
  telegram: [telegram, "botToken"],
  jupiter: [jupiter, "apiKey"],
  relay: [relay, "apiKey"],
  polymarket: [polymarket, "builderPassphrase"],
};

/** Every call the service is asked, as "<url> <the headers that carry a key>". */
function answering(status: number, body: unknown): string[] {
  const asked: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const headers = new Headers(init?.headers);
    asked.push(
      [
        String(input),
        headers.get("x-elfa-api-key") ??
          headers.get("x-api-key") ??
          headers.get("POLY_BUILDER_PASSPHRASE") ??
          "",
      ].join(" "),
    );
    return Response.json(body, { status });
  });
  return asked;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("an app's key", () => {
  it("is tried by every app that takes a secret, before Auni saves it", () => {
    const secrets = apps().filter(({ about }) =>
      Object.values(about.settings ?? {}).some(({ kind }) => kind === "secret"),
    );
    expect(secrets.map(({ about }) => about.id).toSorted()).toEqual(Object.keys(TRIED).toSorted());
    for (const app of secrets) expect(app.tryKey, app.about.id).toBeTypeOf("function");
  });

  for (const [id, [app, key]] of Object.entries(TRIED)) {
    const answers = ANSWERS[id as keyof typeof ANSWERS];
    describe(id, () => {
      // Polymarket's three are one credential: tried as the last comes in, with the other two.
      const stubbed = () => {
        if (id !== "polymarket") return;
        vi.stubEnv("POLYMARKET_BUILDER_API_KEY", "builder-key");
        vi.stubEnv("POLYMARKET_BUILDER_SECRET", Buffer.from("builder-secret").toString("base64"));
      };

      it("works when the service takes it, asking its one call with the typed key", async () => {
        stubbed();
        const asked = answering(answers.took[0], answers.took[1]);
        expect(await app.tryKey!(key, "TYPED")).toBe("works");
        const expected = id === "telegram" ? answers.asks : `${answers.asks} TYPED`;
        expect(asked.map((line) => line.trim())).toEqual([expected]);
      });

      it("is refused when the service refuses it", async () => {
        stubbed();
        answering(answers.refused[0], answers.refused[1]);
        expect(await app.tryKey!(key, "TYPED")).toBe("refused");
      });

      it("can't be tried while the service is down or doesn't answer", async () => {
        stubbed();
        answering(503, { error: "unavailable" });
        expect(await app.tryKey!(key, "TYPED")).toBe("unreachable");
        vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
        expect(await app.tryKey!(key, "TYPED")).toBe("unreachable");
      });
    });
  }

  it("is tried at Telegram with a token that isn't one at all, which it answers 404", async () => {
    answering(404, { ok: false, error_code: 404, description: "Not Found" });
    expect(await telegram.tryKey!("botToken", "abc")).toBe("refused");
  });

  it("waits for Polymarket's other two before trying its builder credentials", async () => {
    const asked = answering(...ANSWERS.polymarket.took);
    vi.stubEnv("POLYMARKET_BUILDER_API_KEY", "");
    vi.stubEnv("POLYMARKET_BUILDER_SECRET", "");
    vi.stubEnv("POLYMARKET_BUILDER_PASSPHRASE", "");
    expect(await polymarket.tryKey!("builderKey", "TYPED")).toBeNull();
    expect(asked).toEqual([]);
  });
});
