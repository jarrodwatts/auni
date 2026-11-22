import { once } from "node:events";
import { statSync } from "node:fs";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname } from "node:path";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { db } from "../db/client.ts";
import { actions, ownerSessions } from "../db/schema.ts";
import { env } from "../env.ts";
import { coreApp } from "../server.ts";
import { insertAction, wipe } from "../test/db.ts";
import { mintPairingCode, pair } from "./owner.ts";
import { doorSocket, openDoor } from "./tailscale.ts";

const OWNER = "owner@example.com";
const ORIGIN = "https://box.tailnet-example.ts.net";

// Always on: Tailscale says who the owner is, and WEB_ORIGIN is this machine's tailnet address.
vi.mock("../env.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../env.ts")>();
  return {
    ...real,
    env: {
      ...real.env,
      TAILSCALE_OWNER: "owner@example.com",
      WEB_ORIGIN: "https://box.tailnet-example.ts.net",
    },
  };
});
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

/** What reached the stand-in web app, by the door's hand. */
const atTheWebApp: IncomingHttpHeaders[] = [];
let webApp: Server;
let door: Server;
let api: Server;

beforeAll(async () => {
  webApp = createServer((req, res) => {
    atTheWebApp.push(req.headers);
    res.end("the web app");
  }).listen(0, "127.0.0.1");
  await once(webApp, "listening");
  env.WEB_PORT = (webApp.address() as AddressInfo).port;
  const app = coreApp();
  door = await openDoor(app, OWNER);
  // Core's own port, which any process on this machine can reach.
  api = app.listen(0, "127.0.0.1");
  await once(api, "listening");
});
afterAll(async () => {
  for (const server of [door, api, webApp]) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
beforeEach(async () => {
  atTheWebApp.length = 0;
  await wipe(ownerSessions);
});

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/** One request, as raw header lines so a header can come twice, through the door or to core's port. */
function send(
  path: string,
  {
    method = "GET",
    headers = [],
    body,
    via = "door",
  }: {
    method?: string;
    headers?: [string, string][];
    body?: unknown;
    via?: "door" | "port";
  } = {},
): Promise<Answer> {
  const target =
    via === "door"
      ? { socketPath: doorSocket() }
      : { host: "127.0.0.1", port: (api.address() as AddressInfo).port };
  const lines = [
    ["host", new URL(ORIGIN).host],
    ["content-type", "application/json"],
    ...headers,
  ].flat();
  return new Promise((resolve, reject) => {
    const sent = request({ ...target, method, path, headers: lines }, (response) => {
      let text = "";
      response.on("data", (chunk: Buffer) => (text += chunk.toString()));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text }),
      );
    });
    sent.on("error", reject);
    sent.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** What `tailscale serve` adds for a request from one of the owner's other devices. */
const FROM_THE_OWNERS_PHONE: [string, string][] = [
  ["tailscale-user-login", OWNER],
  ["tailscale-user-name", "The Owner"],
  ["x-forwarded-for", "100.70.0.2"],
];
const withOrigin = (headers: [string, string][]): [string, string][] => [
  ...headers,
  ["origin", ORIGIN],
];

describe("the door, always on", () => {
  it("lets the owner's device in, to core's routes and the web app alike", async () => {
    const me = await send("/core/me", { headers: FROM_THE_OWNERS_PHONE });
    expect(me.status).toBe(200);
    expect(JSON.parse(me.body)).toMatchObject({ timeZone: "UTC" });

    const page = await send("/app", { headers: FROM_THE_OWNERS_PHONE });
    expect(page).toMatchObject({ status: 200, body: "the web app" });
    // The web app gets the request as the browser sent it, and nothing Tailscale said of the owner.
    expect(atTheWebApp).toHaveLength(1);
    expect(atTheWebApp[0]).toMatchObject({ host: new URL(ORIGIN).host });
    expect(Object.keys(atTheWebApp[0]!).filter((name) => name.startsWith("tailscale-"))).toEqual(
      [],
    );
  });

  it.each<[string, [string, string][]]>([
    [
      "no login: a tagged device, or anything that didn't come through serve",
      [["x-forwarded-for", "100.70.0.2"]],
    ],
    ["the login twice", [["tailscale-user-login", OWNER], ...FROM_THE_OWNERS_PHONE]],
    [
      "another login",
      [
        ["tailscale-user-login", "someone@example.com"],
        ["x-forwarded-for", "100.70.0.3"],
      ],
    ],
    [
      "this machine's own address",
      [
        ["tailscale-user-login", OWNER],
        ["x-forwarded-for", "127.0.0.1"],
      ],
    ],
  ])("turns away a request with %s, from core and the web app", async (_, headers) => {
    const me = await send("/core/me", { headers: withOrigin(headers) });
    expect(me).toMatchObject({ status: 403, body: JSON.stringify({ error: "not_the_owner" }) });
    const page = await send("/app", { headers });
    expect(page.status).toBe(403);
    // A page that names nobody, so a stranger learns nothing of whose Auni this is.
    expect(page.body).toMatch(/This Auni is someone else's|Open Auni from another device/u);
    expect(page.body).not.toContain(OWNER);
    expect(atTheWebApp).toHaveLength(0);
  });

  it("tells the owner on this machine itself to open Auni from another device", async () => {
    const page = await send("/app", {
      headers: [
        ["tailscale-user-login", OWNER],
        ["x-forwarded-for", "127.0.0.1"],
      ],
    });
    expect(page.status).toBe(403);
    expect(page.body).toContain("Open Auni from another device");
  });

  it("answers whether core is up to anyone who reaches it, saying nothing of the owner's", async () => {
    const health = await send("/core/health");
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ status: "ok" });
  });

  it("still takes a change only from the app's own pages", async () => {
    const patch = (headers: [string, string][]) =>
      send("/core/me", { method: "PATCH", headers, body: { name: "Jo" } });
    expect((await patch(FROM_THE_OWNERS_PHONE)).status).toBe(403);
    expect(
      (await patch([...FROM_THE_OWNERS_PHONE, ["origin", "https://evil.example"]])).status,
    ).toBe(403);
    expect((await patch(withOrigin(FROM_THE_OWNERS_PHONE))).status).toBe(200);
  });

  // The owner chose their Tailscale device as the proof the three rare things take.
  it("counts the owner's device as proof they are there", async () => {
    const card = await insertAction({
      status: "awaiting_permission",
      details: { leavesTo: "0x5B7a3f0E2C9d41A8b6e0F7C2d9A4B1E3f6c8D0a2" },
    });
    const allowed = await send(`/core/actions/${card.id}/allow`, {
      method: "POST",
      headers: withOrigin(FROM_THE_OWNERS_PHONE),
    });
    expect(allowed.status).toBe(200);
    const [row] = await db.select().from(actions).where(eq(actions.id, card.id));
    expect(row).toMatchObject({ status: "running" });
    expect(row!.stepUpAt).toBeInstanceOf(Date);

    const keys = await send("/core/me/keys", {
      method: "POST",
      headers: withOrigin(FROM_THE_OWNERS_PHONE),
      body: {},
    });
    expect(JSON.parse(keys.body)).toEqual({ keys: { evm: "0xkey", solana: "base58key" } });
  });

  it("sits in a folder only this user may open, as a socket only this user may", () => {
    expect(statSync(dirname(doorSocket())).mode & 0o777).toBe(0o700);
    expect(statSync(doorSocket()).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(doorSocket())).uid).toBe(process.getuid!());
  });
});

// Core's own port answers every process on this machine, and another user's among them, so it
// must never take what Tailscale's headers say, nor a cookie, as the owner.
describe("core's own port, always on", () => {
  it("turns away forged Tailscale headers", async () => {
    const me = await send("/core/me".slice("/core".length), {
      via: "port",
      headers: withOrigin(FROM_THE_OWNERS_PHONE),
    });
    expect(me).toMatchObject({
      status: 401,
      body: JSON.stringify({ error: "tailscale_owner_only" }),
    });
  });

  it("turns away a session cookie, and pairs no browser", async () => {
    const token = await pair(await mintPairingCode());
    const me = await send("/me", { via: "port", headers: [["cookie", `auni_session=${token}`]] });
    expect(me.status).toBe(401);
    const paired = await send("/owner/pair", {
      via: "port",
      method: "POST",
      headers: [["origin", ORIGIN]],
      body: { code: await mintPairingCode() },
    });
    expect(paired).toMatchObject({ status: 404, body: JSON.stringify({ error: "pairing_off" }) });
    expect(paired.headers["set-cookie"]).toBeUndefined();
  });
});
