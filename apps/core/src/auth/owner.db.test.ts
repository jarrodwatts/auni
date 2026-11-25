import { CARD_FORMAT } from "@auni/shared";
import { createHash, randomUUID } from "node:crypto";
import { request } from "node:http";

import { eq } from "drizzle-orm";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, ownerSessions } from "../db/schema.ts";
import { env } from "../env.ts";
import { handoverRouter } from "../handover/routes.ts";
import { allowAction } from "../money/decide.ts";
import { actionsRouter, proposalsRouter } from "../money/routes.ts";
import { meRouter } from "../routes/me.ts";
import { ownerRouter } from "../routes/owner.ts";
import { insertAction, insertThread, wipe } from "../test/db.ts";
import { serve } from "../test/serve.ts";
import { hostCheck, requireOwner } from "./middleware.ts";
import { mintPairingCode, pairingLink, signOutEverywhere } from "./owner.ts";
import { signTurnToken } from "./turn-token.ts";

vi.mock("../money/wallets.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  walletAddresses: async () => ({ evm: null, solana: null }),
  revealWalletKeys: async () => ({ evm: "0xkey", solana: "base58key" }),
}));
// GET /me says what Auni thinks with; asking a real CLI is no test's business.
vi.mock("../agent/brain.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  brainStatus: async () => ({ ready: false, fixes: [] }),
}));

// As server.ts mounts them, on a port the Host check is told of.
const PORT = 4000;
const url = serve(
  express()
    .use(hostCheck(PORT))
    .use("/owner", ownerRouter)
    .use("/me", requireOwner, meRouter)
    .use("/actions", requireOwner, actionsRouter)
    .use("/proposals", requireOwner, proposalsRouter)
    .use("/handover", requireOwner, handoverRouter),
);

const FROM_THE_APP = { origin: env.WEB_ORIGIN, host: `localhost:${PORT}` };

/** Over node:http, which, unlike fetch, sends whatever Host it is given. */
function send(
  path: string,
  {
    method = "GET",
    headers = {},
    body,
  }: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}> {
  const target = new URL(url(path));
  return new Promise((resolve, reject) => {
    const sent = request(
      target,
      {
        method,
        headers: { host: FROM_THE_APP.host, "content-type": "application/json", ...headers },
      },
      (response) => {
        let text = "";
        response.on("data", (chunk: Buffer) => (text += chunk.toString()));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: text ? (JSON.parse(text) as unknown) : undefined,
          }),
        );
      },
    );
    sent.on("error", reject);
    sent.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const pair = (code: string, headers: Record<string, string> = { origin: env.WEB_ORIGIN }) =>
  send("/owner/pair", { method: "POST", headers, body: { code } });

/** The session cookie a pairing set, as the browser sends it back. */
function cookieOf(response: Awaited<ReturnType<typeof send>>): string {
  const set = response.headers["set-cookie"]?.[0] ?? "";
  return set.split(";")[0]!;
}

beforeEach(async () => {
  await wipe(ownerSessions);
});

describe("pairing", () => {
  it("prints a link whose code rides in the fragment, which no server sees", async () => {
    const code = await mintPairingCode();
    expect(pairingLink(code)).toBe(`${env.WEB_ORIGIN}/app#pair=${code}`);
  });

  it("spends a code once, for a long-lived, script-proof cookie", async () => {
    const code = await mintPairingCode();
    const paired = await pair(code);
    expect(paired.status).toBe(204);
    const set = paired.headers["set-cookie"]?.[0] ?? "";
    expect(set).toMatch(/^auni_session=[\w-]{43}; /u);
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Strict");
    expect(set).toContain("Path=/");
    expect(set).toContain("Max-Age=34560000");
    // WEB_ORIGIN is http://localhost here; an https one adds Secure.
    expect(set).not.toContain("Secure");

    const again = await pair(code);
    expect(again.status).toBe(403);
    expect(again.headers["set-cookie"]).toBeUndefined();
  });

  it("refuses a wrong code and one past its 15 minutes alike", async () => {
    expect((await pair("not-a-code")).body).toEqual({ error: "pairing_code_invalid" });
    const code = await mintPairingCode();
    await db.update(ownerSessions).set({ expiresAt: new Date(Date.now() - 1_000) });
    expect((await pair(code)).status).toBe(403);
  });

  it("takes a code only from the app's own pages", async () => {
    const code = await mintPairingCode();
    expect((await pair(code, { origin: "https://evil.example" })).status).toBe(403);
    expect((await pair(code, {})).status).toBe(403);
    // Refused before it was spent, so the owner's own page still can.
    expect((await pair(code)).status).toBe(204);
  });
});

describe("the owner's session", () => {
  async function paired(): Promise<string> {
    return cookieOf(await pair(await mintPairingCode()));
  }

  it("reaches the owner's routes", async () => {
    const cookie = await paired();
    const me = await send("/me", { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ timeZone: "UTC" });
  });

  it("gives nothing to a request without it, even one from this machine", async () => {
    await paired();
    // The test server is 127.0.0.1, so this request comes from the hub's own machine.
    const me = await send("/me");
    expect(me.status).toBe(401);
    expect(me.body).toEqual({ error: "pairing_required" });
    expect((await send("/me", { headers: { cookie: "auni_session=guess" } })).status).toBe(401);
  });

  // A code is printed in a terminal and rides in a link, so it signs nothing in until it is spent.
  it("never takes a pairing code as the cookie itself", async () => {
    const code = await mintPairingCode();
    expect((await send("/me", { headers: { cookie: `auni_session=${code}` } })).status).toBe(401);
    // Still unspent, so the owner's own page can pair with it.
    expect((await pair(code)).status).toBe(204);
  });

  it("refuses a change from another site's page, which a browser sends the cookie with only same-site", async () => {
    const cookie = await paired();
    const patch = (origin?: string) =>
      send("/me", {
        method: "PATCH",
        headers: { cookie, ...(origin ? { origin } : {}) },
        body: { name: "Jo" },
      });
    expect((await patch("https://evil.example")).status).toBe(403);
    expect((await patch()).status).toBe(403);
    expect((await patch(env.WEB_ORIGIN)).status).toBe(200);
  });

  // Each runs the owner's GitHub CLI or records their answer, so none answers anyone else.
  it("asks for a star only for the owner, from the app's own pages", async () => {
    const cookie = await paired();
    const post = (path: string, headers: Record<string, string>) =>
      send(path, { method: "POST", headers, body: {} });
    for (const path of ["/me/star/check", "/me/star", "/me/star/answer"]) {
      expect((await post(path, { origin: env.WEB_ORIGIN })).status).toBe(401);
      expect((await post(path, { cookie, origin: "https://evil.example" })).status).toBe(403);
      expect((await post(path, { cookie })).status).toBe(403);
    }
    expect((await post("/me/star/answer", { cookie, origin: env.WEB_ORIGIN })).status).toBe(200);
  });

  it("is the only way to allow a card: the agent's turn token allows nothing, of any kind", async () => {
    await paired();
    const thread = await insertThread({ turnStartedAt: new Date() });
    const token = await signTurnToken(
      { threadId: thread.id, turnStartedAt: thread.turnStartedAt!.toISOString() },
      env.TURN_TOKEN_SECRET,
    );
    for (const tool of ["stock_trade", "update_specialist"]) {
      const card = await insertAction({
        threadId: thread.id,
        tool,
        status: "awaiting_permission",
      });
      const allow = await send(`/actions/${card.id}/allow`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, origin: env.WEB_ORIGIN },
        body: {},
      });
      expect(allow.status).toBe(401);
      const [row] = await db.select().from(actions).where(eq(actions.id, card.id));
      expect(row?.status).toBe("awaiting_permission");
    }
  });

  it("ends everywhere when the owner signs every browser out", async () => {
    const cookie = await paired();
    await signOutEverywhere();
    expect((await send("/me", { headers: { cookie } })).status).toBe(401);
  });

  it("stops when it expires", async () => {
    const cookie = await paired();
    await db
      .update(ownerSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(ownerSessions.kind, "session"));
    expect((await send("/me", { headers: { cookie } })).status).toBe(401);
  });
});

describe("the Host check", () => {
  it("answers only the names the hub goes by, so a rebinding domain gets nothing", async () => {
    const cookie = cookieOf(await pair(await mintPairingCode()));
    for (const host of [
      `localhost:${PORT}`,
      `127.0.0.1:${PORT}`,
      `[::1]:${PORT}`,
      "localhost:3000",
    ])
      expect((await send("/me", { headers: { cookie, host } })).status).toBe(200);
    const rebound = await send("/me", { headers: { cookie, host: `evil.example:${PORT}` } });
    expect(rebound.status).toBe(421);
  });
});

/** Makes every session look paired 16 minutes ago (or `minutes`), or only the one `cookie` holds. */
async function age(cookie?: string, minutes = 16): Promise<void> {
  const token = cookie?.split("=")[1];
  await db
    .update(ownerSessions)
    .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
    .where(
      token
        ? eq(ownerSessions.tokenHash, createHash("sha256").update(token).digest("hex"))
        : eq(ownerSessions.kind, "session"),
    );
}

const newlyPaired = async () => cookieOf(await pair(await mintPairingCode()));

// A first send somewhere new, a transaction a tap can't vouch for and showing the keys take
// proof that the owner is there (auth/proof.ts): this browser paired in the last 15 minutes. Who
// can do what, over the routes as server.ts mounts them.
describe("proof that the owner is there", () => {
  const SOMEWHERE_NEW = "0x5B7a3f0E2C9d41A8b6e0F7C2d9A4B1E3f6c8D0a2";
  /** A card waiting on the owner whose money leaves for an address never sent to. */
  const sensitiveCard = () =>
    insertAction({ status: "awaiting_permission", details: { leavesTo: SOMEWHERE_NEW } });
  const rowOf = async (id: string) =>
    (await db.select().from(actions).where(eq(actions.id, id)))[0]!;
  const post = (path: string, cookie: string | null, body: unknown = {}) =>
    send(path, {
      method: "POST",
      headers: { origin: env.WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
      body,
    });
  /** A tap from the web app as it is now, which names the card format it drew. */
  const allow = (id: string, cookie: string | null) =>
    post(`/actions/${id}/allow`, cookie, { cardFormat: CARD_FORMAT });

  /** Still waiting, with no proof recorded: nothing an executor would run. */
  async function expectUntouched(id: string): Promise<void> {
    expect(await rowOf(id)).toMatchObject({ status: "awaiting_permission", stepUpAt: null });
  }
  async function expectAllowed(id: string): Promise<void> {
    const row = await rowOf(id);
    // Allowed and queued to run, with the proof execution checks recorded on the action itself.
    expect(row.status).toBe("running");
    expect(row.stepUpAt).toBeInstanceOf(Date);
  }

  it("paired minutes ago: the tap is enough", async () => {
    const cookie = await newlyPaired();
    await age(cookie, 14);
    const card = await sensitiveCard();
    expect((await allow(card.id, cookie)).status).toBe(200);
    await expectAllowed(card.id);
  });

  it("paired long ago: refused with the way on, then allowed once paired again", async () => {
    const old = await newlyPaired();
    await age();
    const card = await sensitiveCard();
    const refused = await allow(card.id, old);
    expect(refused).toMatchObject({ status: 403, body: { error: "pair_again" } });
    // The card waits, and nothing is lost.
    await expectUntouched(card.id);

    const fresh = await newlyPaired();
    // The older browser's own session proves nothing still: each session has its own pairing.
    expect((await allow(card.id, old)).status).toBe(403);
    await expectUntouched(card.id);
    expect((await allow(card.id, fresh)).status).toBe(200);
    await expectAllowed(card.id);
  });

  it("no session, a guessed one, a signed-out one, or the agent's token: refused", async () => {
    const cookie = await newlyPaired();
    const card = await sensitiveCard();
    const thread = await insertThread({ turnStartedAt: new Date() });
    const token = await signTurnToken(
      { threadId: thread.id, turnStartedAt: thread.turnStartedAt!.toISOString() },
      env.TURN_TOKEN_SECRET,
    );
    expect((await allow(card.id, null)).status).toBe(401);
    expect((await allow(card.id, "auni_session=guess")).status).toBe(401);
    const asAgent = await send(`/actions/${card.id}/allow`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, origin: env.WEB_ORIGIN },
      body: {},
    });
    expect(asAgent.status).toBe(401);
    // A cookie that was the owner's until they signed every browser out.
    await signOutEverywhere();
    expect((await allow(card.id, cookie)).status).toBe(401);
    await expectUntouched(card.id);
  });

  it("a pairing code never spent is no session, however fresh", async () => {
    const card = await sensitiveCard();
    const code = await mintPairingCode();
    expect((await allow(card.id, `auni_session=${code}`)).status).toBe(401);
    await expectUntouched(card.id);
  });

  it("a channel's Allow carries no proof, whoever paired when", async () => {
    await newlyPaired();
    const card = await sensitiveCard();
    // A channel decides through allowAction with nothing but the action (channels/hub.ts).
    expect(await allowAction(card.id)).toEqual({ kind: "refused", reason: "pair_again" });
    await expectUntouched(card.id);
  });

  it("a pairing time the request sends is never read", async () => {
    const cookie = await newlyPaired();
    await age();
    const card = await sensitiveCard();
    const now = new Date().toISOString();
    const claimed = await send(`/actions/${card.id}/allow`, {
      method: "POST",
      headers: {
        cookie: `${cookie}; paired_at=${now}; freshly_paired=true`,
        origin: env.WEB_ORIGIN,
        "x-paired-at": now,
      },
      body: {
        cardFormat: CARD_FORMAT,
        pairedAt: now,
        freshlyPaired: true,
        proof: { freshlyPaired: true },
      },
    });
    expect(claimed).toMatchObject({ status: 403, body: { error: "pair_again" } });
    await expectUntouched(card.id);
  });

  it("a proof for one action allows no other", async () => {
    const cookie = await newlyPaired();
    const first = await sensitiveCard();
    const second = await sensitiveCard();
    // A fresh pairing allowed the first; it proved nothing of the second, tapped later.
    expect((await allow(first.id, cookie)).status).toBe(200);
    await age();
    expect((await allow(second.id, cookie)).status).toBe(403);
    await expectUntouched(second.id);
  });

  it("asks nothing of a card a tap can vouch for", async () => {
    const cookie = await newlyPaired();
    await age();
    const card = await insertAction({ status: "awaiting_permission" });
    expect((await allow(card.id, cookie)).status).toBe(200);
    expect(await rowOf(card.id)).toMatchObject({ status: "running", stepUpAt: null });
  });

  // A tab left open across an update runs the web app from before, which may not draw all a fresh
  // card says (a first sale's lasting permission): its tap names no card format, so it allows
  // nothing, single card or plan, and the tab is told to reload.
  it("allows nothing from a web app that draws cards as they were before", async () => {
    const cookie = await newlyPaired();
    const card = await insertAction({ status: "awaiting_permission" });
    const plan = randomUUID();
    const leg = await insertAction({ status: "awaiting_permission", proposalId: plan });
    for (const [path, body] of [
      [`/actions/${card.id}/allow`, {}],
      [`/actions/${card.id}/allow`, { cardFormat: CARD_FORMAT - 1 }],
      [`/proposals/${plan}/allow`, {}],
    ] as const)
      expect(await post(path, cookie, body)).toMatchObject({
        status: 409,
        body: { error: "out_of_date", message: "Reload Auni to see this card." },
      });
    await expectUntouched(card.id);
    await expectUntouched(leg.id);
  });

  describe("showing the wallet's keys", () => {
    const keys = (cookie: string | null, body: unknown = {}) => post("/me/keys", cookie, body);
    const SHOWN = { keys: { evm: "0xkey", solana: "base58key" } };

    it("shows them to a browser paired minutes ago, as first run's backup is", async () => {
      const cookie = await newlyPaired();
      const shown = await keys(cookie);
      expect(shown.body).toEqual(SHOWN);
      expect(shown.headers["cache-control"]).toBe("no-store");
    });

    it("refuses an older browser until it pairs again, and one without a session", async () => {
      const cookie = await newlyPaired();
      await age();
      expect(await keys(cookie)).toMatchObject({ status: 403, body: { error: "pair_again" } });
      expect((await keys(null)).status).toBe(401);
      expect((await keys(await newlyPaired())).body).toEqual(SHOWN);
    });
  });

  // It hands the keys to another machine, so it takes what showing them takes.
  it("hands Auni over only on that same proof", async () => {
    const cookie = await newlyPaired();
    await age();
    const handover = (from: string) => post("/handover", from, {});
    expect(await handover(cookie)).toMatchObject({ status: 403, body: { error: "pair_again" } });
    // Past the proof, it reads which machine (none here), never touching Tailscale.
    expect(await handover(await newlyPaired())).toMatchObject({
      status: 400,
      body: { error: "invalid_body" },
    });
  });
});
