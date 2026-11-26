import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";

import { appsWireSchema } from "@auni/shared";
import { eq } from "drizzle-orm";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { tempDir } from "../test/temp-dir.ts";
import { toolsFor } from "../agent/mcp.ts";
import { db } from "../db/client.ts";
import { actions, appTroubles, arrivalCursors, fills, jobs, threads } from "../db/schema.ts";
import { actionKind } from "../jobs/kinds.ts";
import { decideActions, executeAction } from "../money/actions.ts";
import { readPortfolio } from "../money/portfolio.ts";
import { recipeForTool } from "../money/recipes/index.ts";
import { forgetKept } from "../money/swaps/shared.ts";
import { insertThread, wipe } from "../test/db.ts";
import { queued } from "../test/jobs.ts";
import {
  PERPS,
  PERPS_CASH_ONLY,
  perpsDeposit,
  perpsHoldings,
} from "../test/second-venues/perps.ts";
import { serve } from "../test/serve.ts";
import { appsRouter } from "./apps.ts";
import { failed } from "./failed.ts";

// The switch, over the real registry with the second venues beside the real apps: Fake Perps
// has a money tool and an account with a long open, as a venue the owner might turn off does.

vi.mock(import("../apps/index.generated.ts"), async (original) =>
  (await import("../test/second-venues/index.ts")).withSecondVenues(await original()),
);
vi.mock(import("@auni/shared"), async (original) =>
  (await import("../test/second-venues/about.ts")).withTheirListings(await original()),
);
vi.mock(import("../money/wallets.ts"), async (original) => ({
  ...(await original()),
  walletAddresses: async () => ({
    evm: "0x00000000000000000000000000000000000000a1",
    solana: null,
  }),
  evmAddress: async () => "0x00000000000000000000000000000000000000a1",
  paysOwnGas: async () => false,
  signerFor: async () => ({}) as never,
}));
// Two brains: one the owner is logged in to, one never installed; or the first signed out and the
// second's sign-in expired. No real CLI is asked.
const brains = vi.hoisted(() => ({ thinking: "claude-code" as string | null }));
vi.mock(import("../agent/brain.ts"), async (original) => ({
  ...(await original()),
  brainRows: async () =>
    brains.thinking
      ? [
          {
            id: "claude-code",
            name: "Claude Code",
            state: "ready" as const,
            login: "your Claude Max subscription",
            models: [],
          },
          {
            id: "codex",
            name: "Codex",
            state: "not-installed" as const,
            fix: "npm install -g @openai/codex",
            models: [],
          },
        ]
      : [
          {
            id: "claude-code",
            name: "Claude Code",
            state: "signed-out" as const,
            fix: "claude auth login",
            models: [],
          },
          {
            id: "codex",
            name: "Codex",
            state: "expired" as const,
            fix: "codex login --device-auth",
            models: [],
          },
        ],
  pickBrain: async () =>
    brains.thinking
      ? ({ about: { id: brains.thinking, name: "Claude Code" }, login: "x" } as never)
      : { fixes: [] },
}));
/** The wallets' own tokens hold nothing, so what's read is what the venues keep. */
vi.mock(import("../money/chain-holdings.ts"), async (original) => ({
  ...(await original()),
  readEvmWallet: async () => [],
  readSolanaWallet: async () => [],
  readSavings: async () => [],
  namesOf: async () => new Map(),
}));

// Behind core's last handler, as the server mounts every router (server.ts).
const url = serve(express().use("/apps", appsRouter).use(failed));

/** A key an app's setting holds, which no answer may carry. */
const KEY = "elfa_live_9f3c2b7a41d84e06b5aa";

let home: string;
const real = process.env.AUNI_HOME;
beforeAll(() => {
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    // Only this test's own server is reached; no venue is.
    if (String(input).startsWith(url())) return realFetch(input, init);
    throw new Error("no network in this test");
  });
  for (const level of ["warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation(() => {});
});
const realFetch = globalThis.fetch;
afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(async () => {
  home = tempDir("auni-apps-");
  process.env.AUNI_HOME = home;
  delete process.env.APPS_OFF;
  // Each test reads the portfolio afresh, not the reading the one before it shared.
  forgetKept();
  await wipe(actions, fills, threads, arrivalCursors, jobs, appTroubles);
});
afterEach(() => {
  process.env.AUNI_HOME = real;
  delete process.env.APPS_OFF;
  delete process.env.ELFA_AUTO_API_KEY;
  delete process.env.TELEGRAM_BOT_TOKEN;
  brains.thinking = "claude-code";
  perpsHoldings.mockReset();
  perpsDeposit.mockReset();
});

const list = async () => appsWireSchema.parse(await (await fetch(url("/apps"))).json()).apps;
const app = async (id: string) => (await list()).find((each) => each.id === id)!;
const turn = (id: string, on: unknown) =>
  fetch(url(`/apps/${id}`), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ on }),
  });
const toolNames = async () => toolsFor({ thread: await insertThread() }).map(({ name }) => name);

describe("GET /apps", () => {
  it("lists every app with its switch and what it needs, and never a setting's value", async () => {
    process.env.ELFA_AUTO_API_KEY = KEY;
    const response = await fetch(url("/apps"));
    const text = await response.text();
    expect(text).not.toContain(KEY);
    const { apps, settingsFile } = appsWireSchema.parse(JSON.parse(text));
    // Where a setting only the owner's file changes is set.
    const envPath = join(home, ".env");
    expect(settingsFile).toBe(
      envPath.startsWith(`${homedir()}/`) ? `~${envPath.slice(homedir().length)}` : envPath,
    );

    // Only what the owner acts through has a switch; what core's own work runs on has none.
    expect(apps.filter(({ canSwitch }) => canSwitch).map(({ id }) => id)).toEqual(
      expect.arrayContaining(["aave", "elfa", "hyperliquid", "polymarket", "telegram", PERPS]),
    );
    for (const id of ["local-key", "privy", "claude-code", "codex", "across", "lifi", "jupiter"])
      expect(
        apps.find((each) => each.id === id),
        id,
      ).toMatchObject({ canSwitch: false, on: true });

    expect(apps.find(({ id }) => id === "elfa")).toMatchObject({
      on: true,
      needs: [],
      settings: [
        {
          key: "apiKey",
          kind: "secret",
          required: true,
          set: "file",
          field: "keys:elfa",
          env: "ELFA_AUTO_API_KEY",
        },
      ],
    });
    // A setting the app only shows has no field to type into.
    expect(apps.find(({ id }) => id === "telegram")).toMatchObject({
      needs: ["Needs a Telegram bot token"],
      pairing: "unset",
      settings: [
        { key: "botToken", kind: "secret", set: null, field: "keys:telegram" },
        { key: "apiUrl", kind: "file", set: null, field: null, env: "TELEGRAM_API_URL" },
      ],
    });
    // This wallet holds an EVM key alone, so a Solana route needs a Solana address before a key.
    expect(apps.find(({ id }) => id === "jupiter")?.needs).toEqual([
      "Needs a Jupiter API key",
      "Needs a Solana address, which Settings adds under Wallet",
    ]);
    // The wallet app the owner doesn't use needs nothing, and says it isn't the one in use.
    expect(apps.find(({ id }) => id === "privy")).toMatchObject({ needs: [], inUse: false });
    expect(apps.find(({ id }) => id === "local-key")).toMatchObject({
      inUse: true,
      jobs: ["keys"],
    });
  });

  it("says a trouble on the sheet of the app it is of, and on no other's", async () => {
    await db.insert(appTroubles).values([
      {
        app: "hyperliquid",
        work: "reading its statement",
        kind: "failing",
        said: "Hyperliquid could not answer userFillsByTime (HTTP 500)",
      },
      { app: "elfa", work: "spending its credits", kind: "credits", said: "out of credits" },
    ]);
    const troubled = (await list()).filter(({ troubles }) => troubles.length > 0);
    expect(
      troubled.map(({ id, troubles }) => ({ id, short: troubles.map(({ short }) => short) })),
    ).toEqual([
      { id: "elfa", short: ["Out of credits"] },
      { id: "hyperliquid", short: ["Not working"] },
    ]);
    expect((await app("hyperliquid")).troubles[0]!.says).toMatch(
      /^Reading its statement failed at .+: Hyperliquid could not answer userFillsByTime \(HTTP 500\)$/u,
    );
  });

  it("says what the owner holds at each app, from one reading", async () => {
    const perps = await app(PERPS);
    expect(perps.account).toEqual({
      usd: "17.34",
      holdings: [
        {
          id: `${PERPS}:USDC`,
          name: "Cash",
          detail: "US dollars",
          logoUrl: expect.any(String),
          usdValue: "12.34",
        },
        {
          id: `${PERPS}:FAKE`,
          name: "FAKE Index 2x long",
          detail: "2 FAKE on Fake Perps",
          logoUrl: "fake.svg",
          usdValue: "5.00",
        },
      ],
      // A move of its own puts money in; it says in words how money comes back.
      moneyIn: null,
      moneyOut: expect.stringMatching(/\w/u),
    });
    // The switch's refusal is known before it is pressed.
    expect(perps.stays).toBe(
      "You have a leveraged position open there, and Auni has to be able to close it.",
    );
    // An account that couldn't be read says so, and never that it holds nothing.
    expect((await app("hyperliquid")).account).toMatchObject({ usd: null, holdings: [] });
    // An app that keeps no money has no account.
    expect((await app("elfa")).account).toBeNull();
  });

  it("says which brain thinks and on what login, and asks for one only while none can", async () => {
    expect(await app("claude-code")).toMatchObject({
      jobs: ["thinks"],
      inUse: true,
      standing: "On your Claude Max subscription",
      needs: [],
    });
    // A second brain that isn't set up is no trouble while the first thinks.
    expect(await app("codex")).toMatchObject({
      inUse: false,
      standing: "Not installed yet",
      needs: [],
    });

    brains.thinking = null;
    expect(await app("claude-code")).toMatchObject({
      inUse: false,
      needs: ["Not signed in yet"],
    });
    expect(await app("codex")).toMatchObject({
      needs: ["Its sign-in has expired"],
    });
  });

  it("says a chat app with its token still waits to be paired", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";
    expect(await app("telegram")).toMatchObject({ pairing: "ready", needs: ["Not paired yet"] });
  });
});

describe("PATCH /apps/:id", () => {
  it("turns off only an app that has a switch", async () => {
    expect((await turn("nobody", false)).status).toBe(404);
    for (const id of ["local-key", "claude-code", "across", "lifi", "fake-bridge"]) {
      const refused = await turn(id, false);
      expect(refused.status, id).toBe(409);
      expect(await refused.json()).toEqual({ error: "no_switch" });
    }
    expect((await turn("aave", "off")).status).toBe(400);
    expect(process.env.APPS_OFF).toBeUndefined();
  });

  it("answers 400 to a body that is not JSON, as to one of the wrong shape", async () => {
    const answer = await fetch(url("/apps/aave"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect({ status: answer.status, body: await answer.json() }).toEqual({
      status: 400,
      body: { error: "invalid_body" },
    });
    expect(process.env.APPS_OFF).toBeUndefined();
  });

  it("takes the app's tools from the agent, and gives them back", async () => {
    expect(await toolNames()).toEqual(
      expect.arrayContaining(["hyperliquid_order", "hyperliquid_markets"]),
    );
    perpsHoldings.mockResolvedValue(PERPS_CASH_ONLY);
    const off = await turn("hyperliquid", false);
    // Hyperliquid's own account can't be read here (no network), so it stays on.
    expect(off.status).toBe(409);
    expect(await off.json()).toMatchObject({ error: "in_use" });

    expect((await turn("polymarket", false)).status).toBe(200);
    expect(await app("polymarket")).toMatchObject({ canSwitch: true, on: false });
    expect(parseEnv(readFileSync(join(home, ".env"), "utf8"))).toEqual({ APPS_OFF: "polymarket" });
    const without = await toolNames();
    expect(without).not.toContain("polymarket_order");
    expect(without).not.toContain("polymarket_markets");
    expect(without).toContain("hyperliquid_order");

    expect((await turn("polymarket", true)).status).toBe(200);
    expect(await toolNames()).toEqual(
      expect.arrayContaining(["polymarket_order", "polymarket_markets"]),
    );
  });

  // With its tools gone, neither Auni nor the specialist managing a leveraged position could
  // close it or set its stops.
  it("refuses to turn off an app whose account holds an open leveraged position", async () => {
    const refused = await turn(PERPS, false);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error: "in_use",
      message: "You have a leveraged position open there, and Auni has to be able to close it.",
    });
    expect(await app(PERPS)).toMatchObject({ on: true });
    expect(await toolNames()).toContain("fake_perps_deposit");

    // Closed, it turns off.
    perpsHoldings.mockResolvedValue(PERPS_CASH_ONLY);
    expect((await turn(PERPS, false)).status).toBe(200);
    expect(await app(PERPS)).toMatchObject({ on: false });
  });

  // The switch changes what the agent is offered, never what core finishes, reads or settles.
  it("leaves a move already allowed to run to done, and its account in the portfolio", async () => {
    perpsHoldings.mockResolvedValue(PERPS_CASH_ONLY);
    const thread = await insertThread();
    const deposit = toolsFor({ thread }).find(
      ({ name }) => name === ("fake_perps_deposit" as string),
    )!;
    // Nothing is in the wallet here, so the card is paid from the account's own cash check off.
    const answer = await deposit.handler({ amountUsd: 5 }).catch((error: unknown) => error);
    const [row] = await db.select().from(actions).where(eq(actions.threadId, thread.id));
    expect(answer, String(answer)).toMatchObject({
      structuredContent: { status: "awaiting_permission" },
    });
    await decideActions({ actionId: row!.id }, "allow");
    expect(await queued(actionKind.name)).toHaveLength(1);

    expect((await turn(PERPS, false)).status).toBe(200);
    expect(await toolNames()).not.toContain("fake_perps_deposit");
    // The move's recipe is still found, so its job runs it and its old card still draws.
    expect(recipeForTool("fake_perps_deposit")?.venue).toBe(PERPS);

    perpsDeposit.mockResolvedValue({
      txs: [{ chain: "base", hash: `0x${"ab".repeat(32)}` }],
      fills: [],
    });
    expect(await executeAction(row!.id)).toMatchObject({ status: "done", error: null });
    expect(perpsDeposit).toHaveBeenCalledOnce();

    const portfolio = await readPortfolio();
    expect(
      portfolio.holdings
        .filter(({ venue }) => venue === PERPS)
        .map(({ instrument, usdValue }) => ({ instrument, usdValue })),
    ).toEqual([{ instrument: "USDC", usdValue: "12.34" }]);
  });
});
