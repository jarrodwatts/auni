import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { channelLinks, owner } from "../db/schema.ts";
import type { Channel } from "../apps/contract.ts";
import { insertAction, setOwner, wipe } from "../test/db.ts";
import { serve } from "../test/serve.ts";
import { meRouter } from "./me.ts";

const WALLETS = { evm: "0x00000000000000000000000000000000000000e1", solana: "So1ana" };
// A wallet brought with its EVM key alone lacks a Solana key until Settings makes one.
const brought = vi.hoisted(() => ({ lacks: null as "solana" | null }));
vi.mock("../money/wallets.ts", async (importOriginal) => {
  const { WalletExists } = await import("../apps/contract.ts");
  return {
    ...(await importOriginal<object>()),
    walletAddresses: async () => WALLETS,
    revealWalletKeys: async () => ({ evm: "0xkey", solana: "base58key" }),
    missingAddress: async () => brought.lacks,
    addMissingKey: async () => {
      if (!brought.lacks) throw new WalletExists();
      brought.lacks = null;
      return WALLETS;
    },
  };
});

const brain = vi.hoisted(() => ({
  status: { ready: true, name: "Claude Code", login: "your Claude Max subscription" } as object,
}));
vi.mock("../agent/brain.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  brainStatus: async () => brain.status,
}));

// Two chat apps: one set up, one waiting for its token. No real app loads: each imports core,
// which would bind to the real registry while this one is still being made.
const chatApps = vi.hoisted(() => [
  { id: "chatty", name: "Chatty", configured: true },
  { id: "later", name: "Later", configured: false },
]);
vi.mock("../apps/registry.ts", () => ({
  brains: () => [],
  offered: () => [],
  channels: () =>
    chatApps.map(({ id, name, configured }) => ({
      about: { id, name },
      channel: { configured: () => configured } as Channel,
    })),
}));

// The owner's GitHub CLI, as each test has it answer.
const github = vi.hoisted(() => ({ starred: false as boolean | null, stars: true }));
vi.mock("../github-star.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  starredOnGitHub: async () => github.starred,
  starOnGitHub: async () => github.stars,
}));

const url = serve(express().use("/me", meRouter));

const setTimeZone = (zone: string) =>
  fetch(url("/me"), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ time_zone: zone }),
  });

const savedZone = async () => (await db.select().from(owner))[0]?.timeZone;

describe("GET /me", () => {
  it("answers the owner with the wallet's addresses, which Add money shows", async () => {
    const response = await fetch(url("/me"));
    const me = (await response.json()) as Record<string, unknown>;
    expect(me).toMatchObject({ name: null, timeZone: "UTC", wallets: WALLETS });
    // One owner: nothing in it names them.
    expect(me).not.toHaveProperty("id");
  });
});

describe("POST /me/wallet/missing", () => {
  it("makes the key a wallet brought with one alone lacks, once", async () => {
    brought.lacks = "solana";
    expect(await (await fetch(url("/me"))).json()).toMatchObject({ walletLacks: "solana" });
    const made = await fetch(url("/me/wallet/missing"), { method: "POST" });
    expect(made.status).toBe(200);
    expect(await made.json()).toMatchObject({ wallets: WALLETS, walletLacks: null });
    const again = await fetch(url("/me/wallet/missing"), { method: "POST" });
    expect([again.status, await again.json()]).toEqual([409, { error: "nothing_missing" }]);
  });
});

describe("what Settings shows", () => {
  const pair = (channel: string) =>
    db.insert(channelLinks).values({ channel, owner: "42", chat: "42" });
  const setHome = (home: string | null) =>
    fetch(url("/me"), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ home_channel: home }),
    });

  it("names the brain and its login, or what to run while none is ready", async () => {
    const answer = async () => (await (await fetch(url("/me"))).json()) as object;
    expect(await answer()).toMatchObject({
      brain: { ready: true, name: "Claude Code", login: "your Claude Max subscription" },
    });
    const restingUntil = new Date("2026-11-06T05:00:00.000Z");
    brain.status = { ready: true, name: "Codex", login: "your ChatGPT plan", restingUntil };
    expect(await answer()).toMatchObject({
      brain: { ready: true, name: "Codex", restingUntil: restingUntil.toISOString() },
    });
    brain.status = { ready: false, fixes: ["Claude Code: run claude auth login"], blocked: true };
    try {
      expect(await answer()).toMatchObject({
        brain: { ready: false, fixes: ["Claude Code: run claude auth login"] },
      });
    } finally {
      brain.status = { ready: true, name: "Claude Code", login: "your Claude Max subscription" };
    }
  });

  it("lists each chat app, set up or not and paired or not, with how to set it up", async () => {
    await pair("chatty");
    expect(await (await fetch(url("/me"))).json()).toMatchObject({
      channels: [
        {
          id: "chatty",
          name: "Chatty",
          configured: true,
          paired: true,
        },
        { id: "later", name: "Later", configured: false, paired: false },
      ],
      home: null,
    });
  });

  it("keeps a home on a paired channel, the web, or wherever they last talked", async () => {
    await pair("chatty");
    for (const home of ["chatty", "web", null]) {
      const response = await setHome(home);
      expect(response.status).toBe(200);
      expect(((await response.json()) as { home: unknown }).home).toBe(home);
    }
  });

  it("refuses a home on a channel that isn't paired, or isn't set up", async () => {
    // Paired once, but its token is gone: nothing could reach it there.
    await pair("later");
    for (const home of ["chatty", "later", "nowhere"]) {
      const response = await setHome(home);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "channel_not_paired" });
    }
    const [row] = await db.select().from(owner);
    expect(row?.homeChannel).toBeNull();
  });
});

describe("PATCH /me", () => {
  it("keeps a time zone Postgres knows", async () => {
    expect((await setTimeZone("Australia/Sydney")).status).toBe(200);
    expect(await savedZone()).toBe("Australia/Sydney");
  });

  // Chrome names some zones by an old name that some Postgres builds don't know.
  it("keeps an old name for a zone under its current one", async () => {
    expect((await setTimeZone("Asia/Calcutta")).status).toBe(200);
    expect(await savedZone()).toBe("Asia/Kolkata");
  });

  // Intl takes it, but every query that reads the day at their time zone would fail.
  it("refuses one only Intl knows", async () => {
    expect((await setTimeZone("SystemV/AST4")).status).toBe(400);
    expect(await savedZone()).toBe("UTC");
  });
});

const post = (path: string, body?: object) =>
  fetch(url(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

// Who may see the keys, session by session, is auth/owner.db.test.ts. Here: no session at all.
describe("POST /me/keys", () => {
  it("shows nothing to a request that proves nothing", async () => {
    const bare = await post("/me/keys");
    expect(bare.status).toBe(403);
    expect(await bare.json()).toEqual({ error: "pair_again" });
  });
});

// What gh answers is github-star.test.ts; here, what core does with each answer.
describe("the ask for a star", () => {
  const starPrompt = async () =>
    ((await (await fetch(url("/me"))).json()) as { starPrompt: string }).starPrompt;
  const answered = async () => (await db.select().from(owner))[0]?.starPromptAnsweredAt ?? null;

  beforeEach(async () => {
    await wipe();
    await setOwner();
    github.starred = false;
    github.stars = true;
  });

  it("waits for a move that landed: not an ask, and not one still running", async () => {
    await insertAction({ status: "running" });
    await insertAction({ status: "failed" });
    await insertAction({ status: "done", tool: "set_thread_autonomy" });
    expect(await starPrompt()).toBe("waiting");
    await insertAction({ status: "done" });
    expect(await starPrompt()).toBe("ask");
  });

  it("never asks again once answered", async () => {
    await insertAction({ status: "done" });
    expect(await (await post("/me/star/answer")).json()).toEqual({ answered: true });
    const first = await answered();
    expect(first).not.toBeNull();
    expect(await starPrompt()).toBe("answered");
    // A second answer, from another device, keeps the first.
    await post("/me/star/answer");
    expect(await answered()).toEqual(first);
  });

  it("takes a star already given as the answer, and a check gh couldn't make as none", async () => {
    await insertAction({ status: "done" });
    github.starred = null;
    expect(await (await post("/me/star/check")).json()).toEqual({ starred: null });
    github.starred = false;
    expect(await (await post("/me/star/check")).json()).toEqual({ starred: false });
    expect(await answered()).toBeNull();
    github.starred = true;
    expect(await (await post("/me/star/check")).json()).toEqual({ starred: true });
    expect(await starPrompt()).toBe("answered");
  });

  it("answers with a star given here, and leaves one gh couldn't give to the owner", async () => {
    await insertAction({ status: "done" });
    github.stars = false;
    expect(await (await post("/me/star")).json()).toEqual({ starred: false });
    expect(await answered()).toBeNull();
    github.stars = true;
    expect(await (await post("/me/star")).json()).toEqual({ starred: true });
    expect(await answered()).not.toBeNull();
  });
});
