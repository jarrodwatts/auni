import { once } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { egressProxy, isPublic } from "./egress.ts";

// This machine as it is, plus a public address on an interface of its own, as a cloud machine
// or a home server with a public IPv4 and IPv6 has.
const OWN_PUBLIC = ["203.0.113.7", "2001:db8::7"];
vi.mock(import("node:os"), async (original) => {
  const os = await original();
  return {
    ...os,
    networkInterfaces: () => ({
      ...os.networkInterfaces(),
      public0: OWN_PUBLIC.map((address) => ({ address }) as never),
    }),
  };
});

describe("which addresses are the public internet", () => {
  it.each([
    "127.0.0.1",
    "127.0.0.2",
    "127.1.2.3",
    "0.0.0.0",
    "10.1.2.3",
    "100.64.12.34",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.20",
    "224.0.0.1",
    "::1",
    "::",
    "::ffff:127.0.0.1",
    "::ffff:7f00:2",
    "::ffff:192.168.1.1",
    "64:ff9b::7f00:1",
    "fd7a:115c:a1e0::1",
    "fe80::1",
    "not an address",
  ])("%s is not", (address) => {
    expect(isPublic(address)).toBe(false);
  });

  it.each(["1.1.1.1", "104.20.23.154", "172.66.147.243", "2606:4700:4700::1111"])(
    "%s is",
    (address) => {
      expect(isPublic(address)).toBe(true);
    },
  );

  it("never counts this machine's own addresses, a public one included", () => {
    const own = Object.values(networkInterfaces())
      .flat()
      .flatMap((each) => (each ? [each.address] : []));
    expect(own).toEqual(expect.arrayContaining(OWN_PUBLIC));
    for (const address of own) expect(isPublic(address)).toBe(false);
  });
});

/** A service on this machine, listening on every address as a dev server often does. */
let target: Server;
let targetPort: number;
const hits: string[] = [];

async function listen(server: Server, host?: string): Promise<number> {
  server.listen(0, host);
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
  target = createServer((req, res) => {
    hits.push(`${req.method} ${req.url} host=${req.headers.host}`);
    res.end("inside");
  });
  targetPort = await listen(target);
});
afterAll(() => target.close());

/** A plain http request through the proxy, as curl sends one: the absolute URL as its path. */
function viaProxy(proxyPort: number, url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: proxyPort, path: url, headers: { host: new URL(url).host } })
      .on("response", (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject)
      .end();
  });
}

/** A CONNECT through the proxy, as https and every other TCP client asks; the tunnel's status. */
function tunnel(proxyPort: number, hostPort: string): Promise<number> {
  return new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: hostPort })
      .on("connect", (res, socket) => {
        socket.destroy();
        resolve(res.statusCode ?? 0);
      })
      .on("error", reject)
      .end();
  });
}

describe("the egress proxy", () => {
  let proxy: Server;
  let proxyPort: number;
  beforeAll(async () => {
    proxy = egressProxy();
    proxyPort = await listen(proxy, "127.0.0.1");
  });
  afterAll(() => proxy.close());

  // Each spelling reaches the service when dialled directly; the sandbox's name list let several through.
  const spellings = [
    "127.0.0.1",
    "127.0.0.2",
    "127.1.2.3",
    "2130706434",
    "localhost",
    "0.0.0.0",
    "[::1]",
    "[::ffff:127.0.0.1]",
  ];

  it.each(spellings)("refuses a request to this machine at %s", async (host) => {
    const answer = await viaProxy(proxyPort, `http://${host}:${targetPort}/`);
    expect(answer.status).toBe(403);
    expect(answer.body).toContain("not on the public internet");
  });

  it.each(spellings)("refuses a tunnel to this machine at %s", async (host) => {
    expect(await tunnel(proxyPort, `${host}:${targetPort}`)).toBe(403);
  });

  it("refuses this machine's own network addresses", async () => {
    const own = Object.values(networkInterfaces())
      .flat()
      .flatMap((each) => (each && each.family === "IPv4" ? [each.address] : []));
    for (const address of own)
      expect(await tunnel(proxyPort, `${address}:${targetPort}`)).toBe(403);
  });

  it("never reached the service", () => {
    expect(hits).toEqual([]);
  });
});

describe("the egress proxy's forwarding", () => {
  // Only this test's own service counts as reachable, to show what passes the check goes through.
  let proxy: Server;
  let proxyPort: number;
  beforeAll(async () => {
    proxy = egressProxy((address) => address === "127.0.0.1");
    proxyPort = await listen(proxy, "127.0.0.1");
  });
  afterAll(() => proxy.close());

  it("forwards a plain http request with its path, query and host", async () => {
    hits.length = 0;
    const answer = await viaProxy(proxyPort, `http://127.0.0.1:${targetPort}/prices?coin=eth`);
    expect(answer).toEqual({ status: 200, body: "inside" });
    expect(hits).toEqual([`GET /prices?coin=eth host=127.0.0.1:${targetPort}`]);
  });

  it("opens a tunnel on the port asked for", async () => {
    expect(await tunnel(proxyPort, `127.0.0.1:${targetPort}`)).toBe(200);
  });

  it("asks for a port on a tunnel", async () => {
    expect(await tunnel(proxyPort, "127.0.0.1")).toBe(400);
  });
});
