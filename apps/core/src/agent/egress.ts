import { lookup } from "node:dns/promises";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { BlockList, connect, isIP } from "node:net";
import { networkInterfaces } from "node:os";

/**
 * Addresses that aren't the public internet: this machine, the networks it sits on (home, office,
 * a tailnet, a cloud's metadata service) and forms that lead back to them. Ranges, not names,
 * since one host has endless names and spellings (127.0.0.2, 2130706434, a DNS name for either).
 * BlockList checks an IPv4 address written as IPv6 (::ffff:127.0.0.1) against the IPv4 ranges.
 */
const NOT_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT, which tailnets use
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3], // multicast and reserved
] as const)
  NOT_PUBLIC.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96], // unspecified, loopback and the old IPv4-compatible form
  ["64:ff9b::", 96], // NAT64, an IPv4 address behind a gateway
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  NOT_PUBLIC.addSubnet(network, prefix, "ipv6");

/**
 * Whether an address is out on the public internet. This machine's own addresses never are,
 * even a public one, since a service listening on every address answers on it too.
 */
export function isPublic(address: string): boolean {
  const family = isIP(address);
  if (!family || NOT_PUBLIC.check(address, family === 4 ? "ipv4" : "ipv6")) return false;
  return !Object.values(networkInterfaces())
    .flat()
    .some((own) => own?.address === address);
}

/**
 * The public address to dial for a host as a client named it; throws when it has none. The caller
 * dials that very address (this proxy, and fetch_url in agent/fetch-tool.ts), so a name can't
 * answer public here and private at the connect.
 */
export async function dialable(
  host: string,
  allowed: (address: string) => boolean,
): Promise<string> {
  const bare = host.replace(/^\[(.*)\]$/u, "$1");
  const found = await lookup(bare, { all: true, order: "ipv4first" }).catch(() => []);
  const address = found.find((each) => allowed(each.address))?.address;
  if (!address)
    throw new Error(
      found.length ? `${host} is not on the public internet` : `${host} doesn't resolve`,
    );
  return address;
}

/** A proxy's own headers, which mean nothing past it. */
function forwarded(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const rest = { ...headers };
  delete rest["proxy-connection"];
  delete rest["proxy-authorization"];
  return rest;
}

/**
 * An HTTP proxy that reaches the public internet and nothing else: CONNECT for https and any
 * other TCP, and plain http requests forwarded. The agent's shell has no network of its own; its
 * CLI's sandbox points every client inside it here, so this is the one door out, and it judges
 * the address it dials rather than the name it was given.
 */
export function egressProxy(allowed: (address: string) => boolean = isPublic): Server {
  const server = createServer((req, res) => {
    const refuse = (status: number, reason: string) => {
      if (res.headersSent) return void res.destroy();
      res.writeHead(status, { "content-type": "text/plain" }).end(`${reason}\n`);
    };
    let target: URL;
    try {
      target = new URL(req.url ?? "");
    } catch {
      return refuse(400, "Only a proxy request (an absolute http:// URL) is served here");
    }
    if (target.protocol !== "http:") return refuse(400, "Use CONNECT for anything but http://");
    dialable(target.hostname, allowed).then(
      (address) => {
        const upstream = request({
          host: address,
          port: target.port || 80,
          method: req.method,
          path: `${target.pathname}${target.search}`,
          headers: forwarded(req.headers),
          setHost: false,
        });
        upstream.on("response", (answer) => {
          res.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
          answer.pipe(res);
        });
        upstream.on("error", (error) => refuse(502, error.message));
        req.pipe(upstream);
      },
      (error: Error) => refuse(403, error.message),
    );
  });
  server.on("connect", (req, client, head) => {
    client.on("error", () => client.destroy());
    // A scheme with no default port, so host:80 keeps its port.
    let target: URL | undefined;
    try {
      target = new URL(`tcp://${req.url ?? ""}`);
    } catch {
      target = undefined;
    }
    if (!target?.port) return client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    const port = Number(target.port);
    dialable(target.hostname, allowed).then(
      (address) => {
        const upstream = connect(port, address);
        let open = false;
        upstream.on("error", () =>
          open ? client.destroy() : client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"),
        );
        upstream.once("connect", () => {
          open = true;
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          upstream.write(head);
          upstream.pipe(client);
          client.pipe(upstream);
        });
        client.on("close", () => upstream.destroy());
      },
      (error: Error) => client.end(`HTTP/1.1 403 Forbidden\r\n\r\n${error.message}\n`),
    );
  });
  return server;
}

let listening: Promise<number> | undefined;

/** The port of this process's one egress proxy on 127.0.0.1, started on first use. */
export function egressPort(): Promise<number> {
  listening ??= new Promise<number>((resolve, reject) => {
    const server = egressProxy();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      // It serves turns while the process runs, and never keeps it running on its own.
      server.unref();
      resolve((server.address() as { port: number }).port);
    });
  }).catch((error: unknown) => {
    listening = undefined;
    throw error;
  });
  return listening;
}
