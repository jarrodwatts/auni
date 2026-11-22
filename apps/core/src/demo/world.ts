// The world outside this machine, as demo mode answers for it. Core reaches the outside through
// two doors, `fetch` (every API, and every chain's RPC) and `WebSocket` (a price stream), and
// `standInForTheWorld` takes both over before anything else loads. From then on a request gets
// the answer of the stand-in service at its host name, and a request to a host with no stand-in
// is refused here, so nothing a demo does ever leaves this machine.
//
//   core, its apps and recipes, unchanged
//        |  fetch("https://api.hyperliquid.xyz/info", ...)
//        v
//   answer()  ->  the Service whose `hosts` hold that name  ->  its answer, as JSON
//        |            (world/*.ts: one file a service)
//        v
//   no stand-in: answered 503, and named once in the demo's output

/** A request core made of the outside, as a stand-in service reads it. */
export interface Asked {
  readonly url: URL;
  readonly method: string;
  /** The request's JSON body; undefined when it had none or it wasn't JSON. */
  readonly body: unknown;
}

/** One outside service, as the demo answers for it. */
export interface Service {
  /** The host names it answers at ("coins.llama.fi"). */
  readonly hosts: readonly string[];
  /**
   * Its answer to one request: a value sent as JSON, or a Response to send as it is. Returning
   * undefined says the service has nothing there (a 404, as the real one would answer).
   */
  answer(asked: Asked): unknown;
  /**
   * For a service core also listens to over a WebSocket: called as a socket to it opens, with
   * the way to tell the listener something, and a signal that aborts once the socket closes.
   * It returns what to do with each message the listener sends.
   */
  socket?(tell: (message: unknown) => void, closed: AbortSignal): (said: unknown) => void;
}

/** An HTTP error from a stand-in service, with the body the real service would send. */
export function refuse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** Whether a URL is Auni's own: core's API or the web app, on this machine. */
function isOwn(url: URL, ownPorts: readonly number[]): boolean {
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  return loopback && url.protocol === "http:" && ownPorts.includes(Number(url.port));
}

async function readBody(request: Request): Promise<unknown> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const text = await request.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Takes over `fetch` and `WebSocket` for the rest of this process. Requests to Auni itself
 * (`ownPorts` on this machine) go through untouched; every other request is answered by the
 * stand-in service at its host, or refused. Nothing reaches the network.
 */
export function standInForTheWorld(
  services: readonly Service[],
  ownPorts: readonly number[],
): void {
  const realFetch = globalThis.fetch;
  const byHost = new Map(
    services.flatMap((service) => service.hosts.map((host) => [host, service])),
  );
  const told = new Set<string>();

  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (isOwn(url, ownPorts)) return realFetch(request);
    const service = byHost.get(url.hostname);
    if (!service) {
      if (!told.has(url.hostname)) {
        told.add(url.hostname);
        console.warn(`The demo has no stand-in for ${url.hostname}, so it answers as if down.`);
      }
      return refuse(503, { error: `The demo has no stand-in for ${url.hostname}.` });
    }
    try {
      const answer = await service.answer({
        url,
        method: request.method,
        body: await readBody(request),
      });
      if (answer instanceof Response) return answer;
      if (answer === undefined) {
        const where = `${url.hostname}${url.pathname}`;
        if (!told.has(where)) {
          told.add(where);
          console.warn(`The demo's stand-in for ${url.hostname} has nothing at ${url.pathname}.`);
        }
        return refuse(404, { error: "not found" });
      }
      return Response.json(answer);
    } catch (error) {
      console.error(`The demo's stand-in for ${url.hostname} failed:`, error);
      return refuse(500, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  globalThis.WebSocket = class extends StandInSocket {
    constructor(url: string | URL) {
      super(url, byHost.get(new URL(url).hostname));
    }
  } as unknown as typeof WebSocket;
}

/**
 * A socket to a stand-in service: it opens, and from then on hears whatever the service tells
 * it. One to a service that keeps no socket opens and stays silent. Nothing is dialled.
 */
class StandInSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly url: string;
  readyState: number = StandInSocket.CONNECTING;
  private readonly closed = new AbortController();
  private hear: (said: unknown) => void = () => {};

  constructor(url: string | URL, service: Service | undefined) {
    super();
    this.url = String(url);
    queueMicrotask(() => {
      if (this.readyState !== StandInSocket.CONNECTING) return;
      this.readyState = StandInSocket.OPEN;
      const tell = (message: unknown) => {
        if (this.readyState === StandInSocket.OPEN)
          this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
      };
      // Before it opens for the listener, who may say something the moment it does.
      this.hear = service?.socket?.(tell, this.closed.signal) ?? this.hear;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string): void {
    this.hear(JSON.parse(data));
  }

  close(): void {
    if (this.readyState === StandInSocket.CLOSED) return;
    this.readyState = StandInSocket.CLOSED;
    this.closed.abort();
    this.dispatchEvent(new Event("close"));
  }
}
