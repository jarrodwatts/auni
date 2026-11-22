import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";

import type { Express } from "express";

import { dataDir } from "../data-dir.ts";
import { passToWebApp } from "../web-app.ts";

// Always-on Auni (TAILSCALE_OWNER set) is reached only through `tailscale serve`, and the owner
// is whoever Tailscale says sent the request. There is no pairing, no session cookie and no port
// of Auni's own that answers as the owner:
//
//   the owner's phone or laptop, signed in to their Tailscale account
//        |  <machine>.<tailnet>.ts.net over https, with Tailscale's own certificate
//        v
//   tailscaled (root) on this machine: drops any Tailscale-User-* headers the request brought,
//        |  adds the sender's login (none for a tagged device) and its tailnet address
//        v
//   the door: a unix socket in a folder only this user (and root) can open, in the data folder,
//        |  which the agent's box hides whole. It checks who sent it (ownerRefusal), then hands
//        |  /core/* to core's routes, marked as the owner's (cameAsOwner), and the rest to the web app
//        v
//   requireOwner (auth/middleware.ts): in this mode, only a request the door marked is the owner's
//
// A request this machine sent to its own tailnet address is refused: Tailscale names this
// machine's user as its sender, so any process here (another user's, a container's) would pass
// for the owner, where the socket's folder keeps them out. The owner opens Auni from their other
// devices; a process of the owner's own user here already reaches the keys and needs no door.

/** The door's socket, in a folder of its own that only this user and root may open. */
export function doorSocket(): string {
  return join(dataDir(), "serve", "auni.sock");
}

/** The longest unix socket path Linux and macOS take (sun_path, less its closing zero). */
const SOCKET_PATH_MAX = 103;

const ITSELF = "it came from this machine itself";

/** Why a request through the door isn't the owner's, in a few words for the log; null when it is. */
export function ownerRefusal(
  req: Pick<IncomingMessage, "headersDistinct">,
  owner: string,
  ownAddress: (address: string) => boolean = onThisMachine,
): string | null {
  const logins = req.headersDistinct["tailscale-user-login"] ?? [];
  // None: a tagged device, which Tailscale names no user for, or no Tailscale at all.
  if (logins.length === 0) return "no Tailscale login came with it";
  if (logins.length > 1) return "it came with more than one Tailscale login";
  if (logins[0]!.trim().toLowerCase() !== owner.trim().toLowerCase())
    return "it came from another Tailscale login";
  // Serve sets this afresh to the sender's tailnet address, dropping any the request brought.
  const from = req.headersDistinct["x-forwarded-for"] ?? [];
  if (from.length !== 1 || from[0]!.includes(",")) return "it didn't say one address it came from";
  if (ownAddress(from[0]!.trim().replace(/^\[(.*)\]$/u, "$1"))) return ITSELF;
  return null;
}

function onThisMachine(address: string): boolean {
  return Object.values(networkInterfaces())
    .flat()
    .some((own) => own?.address === address);
}

/** The requests the door let in as the owner's: set only here, so nothing a request says is read. */
const owners = new WeakSet<IncomingMessage>();

/** Whether the door let this request in as the owner's. */
export function cameAsOwner(req: IncomingMessage): boolean {
  return owners.has(req);
}

/**
 * Opens the door on its socket, in front of core's routes (`app`) and the web app. Refuses to open
 * where the socket's folder is anyone else's, or opens to anyone else.
 */
export async function openDoor(app: Express, owner: string): Promise<Server> {
  const socket = doorSocket();
  if (socket.length > SOCKET_PATH_MAX)
    throw new Error(
      `The door's socket would be ${socket} (${socket.length} characters), longer than a unix socket can be: give AUNI_HOME a shorter path.`,
    );
  const folder = dirname(socket);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const held = lstatSync(folder);
  if (!held.isDirectory() || held.uid !== process.getuid?.())
    throw new Error(`${folder} isn't a folder of this user's, so Auni won't open its door there.`);
  // A socket left by an Auni that stopped without closing it.
  rmSync(socket, { force: true });

  const door = createServer((req, res) => {
    const path = req.url ?? "/";
    // Whether the web app reaches core, which doctor and setup ask from this machine. It says
    // nothing of the owner's, so it answers anyone who reaches the door.
    if (path === "/core/health") {
      req.url = "/health";
      return void app(req, res);
    }
    const refusal = ownerRefusal(req, owner);
    if (refusal) return refuse(req, res, refusal);
    owners.add(req);
    if (path.startsWith("/core/")) {
      req.url = path.slice("/core".length);
      return void app(req, res);
    }
    passToWebApp(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    door.once("error", reject);
    door.listen(socket, () => resolve());
  });
  chmodSync(socket, 0o600);
  return door;
}

/** A plain refusal that names nobody: the page a stranger's browser shows, or core's error. */
function refuse(req: IncomingMessage, res: ServerResponse, why: string): void {
  console.warn(`A request through Tailscale was turned away: ${why}.`);
  if (req.url?.startsWith("/core/")) {
    res.writeHead(403, { "content-type": "application/json" });
    return void res.end(JSON.stringify({ error: "not_the_owner" }));
  }
  res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(why === ITSELF ? THIS_MACHINE : SOMEONE_ELSES);
}

/** The refusal as a page: a stranger learns nothing of whose Auni this is. */
const page = (title: string, says: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auni</title>
<style>body{font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1d1d1f;background:#fff}
@media (prefers-color-scheme:dark){body{color:#f5f5f7;background:#111}}</style></head>
<body><h1>${title}</h1><p>${says}</p></body></html>
`;

const SOMEONE_ELSES = page(
  "This Auni is someone else's",
  "It answers only the Tailscale account that set it up, from that account's own devices. If it's yours, sign in to Tailscale on this device with that account and open it again.",
);
const THIS_MACHINE = page(
  "Open Auni from another device",
  "Auni doesn't answer the machine it runs on, since any program here could pass for you. Open it from your phone or laptop, signed in to Tailscale.",
);
