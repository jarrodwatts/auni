import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { brainRows } from "./agent/brain.ts";
import { db } from "./db/client.ts";
import { ownerSessions } from "./db/schema.ts";
import { ownerState, readSetup, walletFacts } from "./setup.ts";
import { setOwner, wipe } from "./test/db.ts";

vi.mock("./agent/brain.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  brainRows: vi.fn(),
}));
const MONAD = "0x1111111111111111111111111111111111111111";
const wallet = vi.hoisted(() => ({ made: false, bring: true }));
vi.mock("./apps/registry.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./apps/registry.ts")>();
  return {
    ...real,
    walletApp: () => ({
      about: { id: "stand-in", name: "Stand-in" },
      provided: {
        addresses: async () =>
          wallet.made ? { evm: MONAD, solana: null } : { evm: null, solana: null },
        ...(wallet.bring ? { bring: { id: "keys", inputs: [], check: vi.fn() } } : {}),
      },
    }),
  };
});

beforeEach(async () => {
  await wipe(ownerSessions);
  await setOwner({ backupSavedAt: null, welcomedAt: null });
  Object.assign(wallet, { made: false, bring: true });
  vi.mocked(brainRows).mockResolvedValue([
    { id: "claude-code", name: "Claude Code", state: "signed-out", fix: "claude auth login" },
  ]);
  // The web app answers.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
});
afterEach(() => vi.restoreAllMocks());

const session = (createdAt = new Date()) =>
  db.insert(ownerSessions).values({
    tokenHash: `hash-${createdAt.getTime()}`,
    kind: "session",
    expiresAt: new Date(Date.now() + 60 * 60_000),
    createdAt,
  });

describe("readSetup", () => {
  it("reads a fresh machine as nothing done, and makes nothing on the way", async () => {
    expect(await readSetup()).toMatchObject({
      platform: "ok",
      brains: {
        rows: [{ id: "claude-code", state: "signed-out", fix: "claude auth login" }],
        blocked: null,
      },
      running: { running: false, webAnswers: true, browser: null },
      paired: false,
    });
    // No pairing code, no session.
    expect(await db.select().from(ownerSessions)).toEqual([]);
  });

  it("reads what the running Auni did with the browser from its own word, and a link run out", async () => {
    const said = (browser: object) =>
      vi.mocked(fetch).mockResolvedValue(Response.json({ status: "ok", browser }));
    said({ how: "no-screen", at: new Date().toISOString() });
    expect((await readSetup()).running.browser).toBe("no-screen");
    said({ how: "opened", at: new Date().toISOString() });
    expect((await readSetup()).running.browser).toBe("opened");
    said({ how: "opened", at: new Date(Date.now() - 16 * 60_000).toISOString() });
    expect((await readSetup()).running.browser).toBe("ran-out");
    // A web app that doesn't answer says nothing of the browser.
    vi.mocked(fetch).mockRejectedValue(new Error("connection refused"));
    expect((await readSetup()).running).toEqual({
      running: false,
      webAnswers: false,
      browser: null,
    });
  });

  it("reads a paired browser", async () => {
    await session();
    expect((await readSetup()).paired).toBe(true);
  });
});

describe("ownerState", () => {
  it("reads a fresh owner as unpaired, with no backup or first run", async () => {
    expect(await ownerState()).toEqual({
      pairedAt: null,
      backupSavedAt: null,
      backupLaterAt: null,
      welcomedAt: null,
    });
  });

  it("reads a pairing, the backup and the end of first run", async () => {
    const pairedAt = new Date(Date.now() - 60_000);
    const saved = new Date(Date.now() - 30_000);
    await session(pairedAt);
    await setOwner({ backupSavedAt: saved, welcomedAt: saved });
    expect(await ownerState()).toEqual({
      pairedAt,
      backupSavedAt: saved,
      backupLaterAt: null,
      welcomedAt: saved,
    });
  });
});

describe("walletFacts", () => {
  it("has no addresses until the owner makes a wallet, and says whether it takes keys", async () => {
    expect(await walletFacts()).toEqual({
      app: "stand-in",
      name: "Stand-in",
      bring: { id: "keys", inputs: [] },
      addresses: null,
    });
    Object.assign(wallet, { made: true, bring: false });
    expect(await walletFacts()).toMatchObject({
      bring: null,
      addresses: { evm: MONAD, solana: null },
    });
  });
});
