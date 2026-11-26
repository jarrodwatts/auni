import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { tempDir } from "../test/temp-dir.ts";
import { toolsFor } from "../agent/mcp.ts";
import type { ThreadRow } from "../db/schema.ts";
import { PrivateFieldRefused, type PrivateField } from "../private-fields.ts";
import { savedUntried } from "../settings.ts";
import { serve } from "../test/serve.ts";
import { privateRouter } from "./private.ts";

const fields = vi.hoisted(() => ({ wallet: [] as PrivateField[] }));
vi.mock("../money/wallets.ts", async (original) => ({
  ...(await original()),
  walletFields: async () => fields.wallet,
}));

// web3's documented account: what the owner types, which must show up nowhere but core.
const EVM_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const EVM_ADDRESS = "0x2c7536E3605D9C16a7a3D7b1898e529396a65c23";
const SECRET = EVM_KEY.slice(2, 40);
// An API key the owner pastes for an app, which must show up nowhere but the settings file.
const API_KEY = "elfa_live_9f3c2b7a41d84e06b5aa";

// Whether a request proves the owner is there is requireOwner's to judge (auth/proof.ts); here a
// header stands in for it.
const url = serve(
  express()
    .use((req, _res, next) => {
      req.ownerHere = req.headers["x-test-here"] === "yes";
      next();
    })
    .use("/private", privateRouter),
);

/**
 * A wallet's keys field, stood in: it takes an EVM key once, refusing in fixed words what isn't
 * one and any over keys it holds. (The local-key wallet's own is tested beside it.)
 */
function keysField(): PrivateField & { held: string | null } {
  const field = {
    held: null as string | null,
    id: "wallet-keys",
    label: "Wallet keys",
    goes: "It goes straight to Auni's wallet on this computer.",
    app: "local-key",
    link: null,
    confirms: true,
    proof: false,
    inputs: [
      { name: "evm", label: "EVM private key", placeholder: "0x", set: false },
      { name: "solana", label: "Solana private key", placeholder: "base58", set: false },
    ],
    async check(values: Readonly<Record<string, string>>) {
      if (field.held) throw new PrivateFieldRefused("Auni holds a wallet here already.");
      if (values.evm !== EVM_KEY) throw new PrivateFieldRefused("That EVM key isn't one.");
      return { preview: `EVM ${EVM_ADDRESS}`, notes: ["Someone may hold a copy."] };
    },
    async accept(values: Readonly<Record<string, string>>) {
      await field.check(values);
      field.held = values.evm!;
      return null;
    },
  };
  return field;
}

/** Everything written to the console while a test runs. */
let logged = "";
let field: ReturnType<typeof keysField>;
beforeEach(() => {
  logged = "";
  for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const)
    vi.spyOn(console, level).mockImplementation((...said: unknown[]) => {
      logged += `${said.map((each) => (each instanceof Error ? `${each.stack}` : String(each))).join(" ")}\n`;
    });
  field = keysField();
  fields.wallet = [field];
});
afterEach(() => vi.restoreAllMocks());

const send = (path: string, body: unknown, here = false) =>
  fetch(url(`/private/${path}`), {
    method: "POST",
    headers: { "content-type": "application/json", ...(here ? { "x-test-here": "yes" } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

/** A response read whole, checked never to carry the secret or be cacheable. */
async function answered(response: Response) {
  const text = await response.text();
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(API_KEY);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

afterEach(() => {
  expect(logged).not.toContain(SECRET);
  expect(logged).not.toContain(API_KEY);
});

describe("a private field", () => {
  it("says what the keys sign for, then takes them in, echoing them nowhere", async () => {
    expect(await answered(await send("wallet-keys/check", { values: { evm: EVM_KEY } }))).toEqual({
      status: 200,
      body: { preview: `EVM ${EVM_ADDRESS}`, notes: ["Someone may hold a copy."] },
    });
    expect(await answered(await send("wallet-keys", { values: { evm: EVM_KEY } }))).toEqual({
      status: 200,
      body: { said: null },
    });
    expect(field.held).toBe(EVM_KEY);
  });

  it("refuses keys once a wallet is held, in its own fixed words", async () => {
    field.held = "0xsome-other-key";
    expect(await answered(await send("wallet-keys", { values: { evm: EVM_KEY } }))).toEqual({
      status: 400,
      body: { error: "refused", message: "Auni holds a wallet here already." },
    });
    expect(field.held).toBe("0xsome-other-key");
  });

  it("refuses what isn't a key without repeating it", async () => {
    const typed = `${SECRET}zz`;
    const refused = await send("wallet-keys/check", { values: { evm: typed } });
    const text = await refused.text();
    expect(refused.status).toBe(400);
    expect(text).not.toContain(typed);
  });

  it("knows only its own fields and inputs", async () => {
    expect((await answered(await send("api-key", { values: { key: EVM_KEY } }))).status).toBe(404);
    expect(
      (await answered(await send("wallet-keys", { values: { evm: EVM_KEY, seed: "x" } }))).status,
    ).toBe(400);
    expect((await answered(await send("wallet-keys", { evm: EVM_KEY }))).status).toBe(400);
    expect(field.held).toBeNull();
  });

  it("turns down a body that isn't JSON without logging it", async () => {
    expect(await answered(await send("wallet-keys", `{"values":{"evm":"${EVM_KEY}"`))).toEqual({
      status: 400,
      body: { error: "invalid_body" },
    });
    expect(
      (await answered(await send("wallet-keys", { values: { evm: EVM_KEY.repeat(80) } }))).status,
    ).toBe(400);
  });

  it("answers a failure bare, logging only which field failed", async () => {
    fields.wallet = [
      {
        ...field,
        accept: async (values) => {
          throw new Error(`couldn't store ${values.evm}`);
        },
      },
    ];
    expect(await answered(await send("wallet-keys", { values: { evm: EVM_KEY } }))).toEqual({
      status: 500,
      body: { error: "internal" },
    });
    expect(logged).toBe("private field wallet-keys failed\n");
  });
});

describe("a field that takes proof the owner is there", () => {
  // As the Solana key brought beside an EVM key is (money/wallets.ts): someone else's key pasted
  // from an unlocked laptop would catch every coin later sent to the wallet's Solana address.
  let solana: PrivateField & { held: string | null };
  beforeEach(() => {
    solana = Object.assign(keysField(), {
      id: "wallet-solana",
      proof: true,
      inputs: [{ name: "evm", label: "Solana private key", placeholder: "base58", set: false }],
    });
    fields.wallet = [field, solana];
  });

  it("says so before anything is typed, and takes nothing without it", async () => {
    const read = (here: boolean) =>
      fetch(url("/private/wallet-solana"), { headers: here ? { "x-test-here": "yes" } : {} });
    expect(await answered(await read(false))).toEqual({
      status: 403,
      body: { error: "pair_again" },
    });
    expect(await answered(await read(true))).toEqual({
      status: 200,
      body: {
        id: "wallet-solana",
        label: "Wallet keys",
        goes: "It goes straight to Auni's wallet on this computer.",
        app: "local-key",
        inputs: [{ name: "evm", label: "Solana private key", placeholder: "base58", set: false }],
        link: null,
        confirms: true,
        proof: true,
      },
    });
    for (const step of ["wallet-solana/check", "wallet-solana"])
      expect(await answered(await send(step, { values: { evm: EVM_KEY } }))).toEqual({
        status: 403,
        body: { error: "pair_again" },
      });
    expect(solana.held).toBeNull();
  });

  it("is asked again as the key is taken, whatever the check found", async () => {
    expect((await send("wallet-solana/check", { values: { evm: EVM_KEY } }, true)).status).toBe(
      200,
    );
    expect((await send("wallet-solana", { values: { evm: EVM_KEY } })).status).toBe(403);
    expect(solana.held).toBeNull();
    expect((await send("wallet-solana", { values: { evm: EVM_KEY } }, true)).status).toBe(200);
    expect(solana.held).toBe(EVM_KEY);
  });

  it("takes none from a field that doesn't ask for it", async () => {
    expect((await send("wallet-keys", { values: { evm: EVM_KEY } })).status).toBe(200);
  });
});

describe("an app's secret setting", () => {
  const FIELD = encodeURIComponent("keys:elfa");
  const thread = { id: "t" } as ThreadRow;
  const offered = () => toolsFor({ thread }).map((tool) => tool.name);

  // A settings file of this test's own, as an owner might have written it by hand.
  const real = process.env.AUNI_HOME;
  const BY_HAND = "# My settings\nRPC_URL_BASE='https://base.example'\n";
  let home: string;
  const settings = () => readFileSync(join(home, ".env"), "utf8");
  // Elfa as it answered a key on 2026-11-13, at the one call its key is tried with (key-status).
  const ELFA = {
    took: () =>
      Response.json({ plan: "free", scopes: ["key-status"], credits: { remaining: 1000 } }),
    refused: () =>
      Response.json(
        { code: "ERR_UNAUTHORIZED", message: "Invalid or expired API key" },
        { status: 401 },
      ),
    down: () => Promise.reject(new TypeError("fetch failed")),
  };
  let elfaSays: () => Response | Promise<Response> = ELFA.took;
  const asked: string[] = [];
  beforeEach(() => {
    home = tempDir("auni-private-");
    process.env.AUNI_HOME = home;
    writeFileSync(join(home, ".env"), BY_HAND);
    elfaSays = ELFA.took;
    asked.length = 0;
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const to = String(input instanceof Request ? input.url : input);
      if (!to.startsWith("https://api.elfa.ai/")) return real(input, init);
      asked.push(`${to} ${new Headers(init?.headers).get("x-elfa-api-key")}`);
      return elfaSays();
    });
  });
  afterEach(() => {
    process.env.AUNI_HOME = real;
    delete process.env.ELFA_AUTO_API_KEY;
  });

  it("is saved through its private field and works on the agent's next tool list, echoed nowhere", async () => {
    expect(offered()).not.toContain("market_news");
    const checked = await answered(await send(`${FIELD}/check`, { values: { apiKey: API_KEY } }));
    expect(checked).toEqual({ status: 200, body: { preview: "", notes: [] } });
    // Checking keeps nothing.
    expect(offered()).not.toContain("market_news");
    expect(settings()).toBe(BY_HAND);

    expect(await answered(await send(FIELD, { values: { apiKey: API_KEY } }))).toEqual({
      status: 200,
      body: { said: null },
    });
    // Elfa was asked about the key, at its free call, before it was saved.
    expect(asked).toEqual([`https://api.elfa.ai/v3/key-status ${API_KEY}`]);
    // No restart: the list is built for each request, and the app reads its key as it is asked.
    expect(offered()).toEqual(expect.arrayContaining(["market_news", "market_pulse"]));
    expect(settings()).toBe(`${BY_HAND}ELFA_AUTO_API_KEY='${API_KEY}'\n`);
    expect(statSync(join(home, ".env")).mode & 0o777).toBe(0o600);
    expect(logged).toBe("");
  });

  // A made-up key once answered "Elfa is connected".
  it("isn't saved when Elfa refuses it, and says so in words that never repeat it", async () => {
    elfaSays = ELFA.refused;
    expect(await answered(await send(FIELD, { values: { apiKey: API_KEY } }))).toEqual({
      status: 400,
      body: {
        error: "refused",
        message:
          "Elfa refused that key, so nothing was saved. Check you copied all of it, and paste it again.",
      },
    });
    expect(settings()).toBe(BY_HAND);
    expect(offered()).not.toContain("market_news");
    expect(logged).toBe("");
  });

  it("is saved when Elfa can't be asked, saying it wasn't tried", async () => {
    elfaSays = ELFA.down;
    expect(await answered(await send(FIELD, { values: { apiKey: API_KEY } }))).toEqual({
      status: 200,
      body: {
        said: "Saved, but Elfa couldn't be reached to try it. Auni uses it from now on, and says so if Elfa turns it down.",
      },
    });
    expect(settings()).toBe(`${BY_HAND}ELFA_AUTO_API_KEY='${API_KEY}'\n`);
    // Its sheet says so beside the key, until it is saved again with Elfa answering.
    expect(savedUntried("ELFA_AUTO_API_KEY")).toBe(true);
    elfaSays = ELFA.took;
    await send(FIELD, { values: { apiKey: API_KEY } });
    expect(savedUntried("ELFA_AUTO_API_KEY")).toBe(false);
    expect(logged).toBe("");
  });

  it("refuses a value that would set something else, in fixed words that never repeat it", async () => {
    for (const value of [
      `${API_KEY}\nRPC_URL_BASE=https://evil.example`,
      `${API_KEY}' RPC_URL_BASE='https://evil.example`,
    ]) {
      const refused = await answered(await send(FIELD, { values: { apiKey: value } }));
      expect(refused).toMatchObject({ status: 400, body: { error: "refused" } });
      expect(JSON.stringify(refused.body)).not.toContain("evil");
    }
    expect(settings()).toBe(BY_HAND);
    expect(offered()).not.toContain("market_news");
  });

  it("has no field that reaches a setting which isn't an app's own secret", async () => {
    const tries = [
      ["RPC_URL_BASE", { value: "https://evil.example" }],
      ["keys:core", { WALLET: "privy" }],
      ["setting:elfa:apiKey", { value: "https://evil.example" }],
      ["keys:telegram", { apiUrl: "https://evil.example" }],
    ] as const;
    for (const [id, values] of tries)
      expect([400, 404], id).toContain(
        (await answered(await send(encodeURIComponent(id), { values }))).status,
      );
    // Nor an input of the field's that names another setting.
    expect(
      await answered(await send(FIELD, { values: { RPC_URL_BASE: "https://evil.example" } })),
    ).toEqual({ status: 400, body: { error: "invalid_body" } });
    expect(settings()).toBe(BY_HAND);
  });

  it("is cleared by its field, and the app works as if it was never given", async () => {
    await send(FIELD, { values: { apiKey: API_KEY } });
    expect(offered()).toContain("market_news");
    const clear = await fetch(url(`/private/${FIELD}/clear`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "apiKey" }),
    });
    expect(await answered(clear)).toEqual({ status: 200, body: { said: null } });
    expect(settings()).toBe(`${BY_HAND}ELFA_AUTO_API_KEY=''\n`);
    expect(offered()).not.toContain("market_news");
  });

  it("answers a file it can't write bare, logging neither the key nor the error", async () => {
    // A folder where the settings file should be, so it can be neither read nor replaced.
    rmSync(join(home, ".env"));
    mkdirSync(join(home, ".env"));
    expect(await answered(await send(FIELD, { values: { apiKey: API_KEY } }))).toEqual({
      status: 500,
      body: { error: "internal" },
    });
    expect(logged).toBe("private field keys:elfa failed\n");
    expect(offered()).not.toContain("market_news");
  });
});
