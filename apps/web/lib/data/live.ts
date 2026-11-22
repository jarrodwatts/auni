import type { LiveMessage as Live } from "@auni/shared";
import type { UIMessageChunk } from "ai";

/** A message from core's `GET /live`, its row not yet parsed. */
type LiveMessage = Live<UIMessageChunk, unknown>;

/**
 * One stream from core for the whole tab, shared by everything that listens: rows, an open
 * thread, a chat waiting on its answer. A browser opens at most six connections to one host, so
 * a stream each would run out with two tabs open.
 *
 * The browser brings a dropped stream back by itself (sleep, a network change, core restarting
 * quickly). One core refused, such as a signed-out session or core down behind the rewrite, is
 * closed for good, so it comes back here after a growing wait.
 */
const PATH = "/core/live";

interface Listener {
  readonly onMessage: (message: LiveMessage) => void;
  readonly onOpen: () => void;
  readonly onError: () => void;
}

const listeners = new Set<Listener>();
let source: EventSource | undefined;
let failures = 0;
let retry: ReturnType<typeof setTimeout> | undefined;

function connect(): void {
  clearTimeout(retry);
  retry = undefined;
  const opened = new EventSource(PATH);
  source = opened;
  opened.onopen = () => {
    failures = 0;
    for (const listener of [...listeners]) listener.onOpen();
  };
  opened.onmessage = (event: MessageEvent<string>) => {
    const message = JSON.parse(event.data) as LiveMessage;
    for (const listener of [...listeners]) {
      // One listener refusing a message (a row it can't parse) leaves the rest to hear it.
      try {
        listener.onMessage(message);
      } catch (error) {
        console.error("live message not handled", error);
      }
    }
  };
  opened.onerror = () => {
    for (const listener of [...listeners]) listener.onError();
    if (opened.readyState !== EventSource.CLOSED) return;
    opened.close();
    source = undefined;
    failures += 1;
    retry = setTimeout(connect, Math.min(30_000, 1_000 * 2 ** failures));
  };
}

function disconnect(): void {
  clearTimeout(retry);
  retry = undefined;
  source?.close();
  source = undefined;
}

/**
 * Hears everything core streams until `close`. `open()` settles once the stream is open now, so
 * all from then on is heard: at once while it is, else on its next open, or fails if it errs
 * first. `onGap` runs each time it opens after it dropped or failed to open, since whatever was
 * sent in between was missed.
 */
export function listenLive(
  onMessage: (message: LiveMessage) => void,
  onGap: () => void = () => {},
): { readonly open: () => Promise<void>; readonly close: () => void } {
  // Whether it has opened or failed yet: any open after that follows a time it heard nothing.
  let tried = false;
  const waiting: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const listener: Listener = {
    onMessage,
    onOpen: () => {
      if (tried) onGap();
      tried = true;
      for (const wait of waiting.splice(0)) wait.resolve();
    },
    onError: () => {
      tried = true;
      for (const wait of waiting.splice(0))
        wait.reject(new Error("The live stream from core didn't open"));
    },
  };
  listeners.add(listener);
  if (source?.readyState === EventSource.OPEN) listener.onOpen();
  else if (!source) connect();
  return {
    open: () => {
      if (source?.readyState === EventSource.OPEN) return Promise.resolve();
      const opened = new Promise<void>((resolve, reject) => waiting.push({ resolve, reject }));
      // A stream waiting out its retry comes back now that someone wants it.
      if (!source) connect();
      return opened;
    },
    close: () => {
      listeners.delete(listener);
      if (listeners.size === 0) disconnect();
    },
  };
}
