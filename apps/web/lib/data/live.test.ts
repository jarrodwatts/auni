import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listenLive } from "./live";

/** The browser's EventSource, driven by the test: each one made is kept, newest last. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static made: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.made.push(this);
  }
  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }
  send(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  /** Dropped, and the browser trying again by itself. */
  drop() {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.();
  }
  /** Refused by core: closed for good. */
  refuse() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

const newest = () => FakeEventSource.made.at(-1)!;
const row = { topic: "row", thread: { id: "t" } };
let closes: (() => void)[] = [];
const listen = (...args: Parameters<typeof listenLive>) => {
  const live = listenLive(...args);
  closes.push(live.close);
  return live;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", FakeEventSource);
  FakeEventSource.made = [];
});
afterEach(() => {
  closes.forEach((close) => close());
  closes = [];
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the tab's live stream", () => {
  it("is one stream through the /core rewrite, heard by every listener", () => {
    const first = vi.fn();
    const second = vi.fn();
    listen(first);
    listen(second);
    expect(FakeEventSource.made.map((source) => source.url)).toEqual(["/core/live"]);
    newest().open();
    newest().send(row);
    expect(first).toHaveBeenCalledWith(row);
    expect(second).toHaveBeenCalledWith(row);
  });

  it("reaches the rest when one listener throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const heard = vi.fn();
    listen(() => {
      throw new Error("unparseable");
    });
    listen(heard);
    newest().open();
    newest().send(row);
    expect(heard).toHaveBeenCalledWith(row);
  });

  it("opens for a listener that joins once it already is", async () => {
    listen(() => {});
    newest().open();
    await expect(listen(() => {}).open()).resolves.toBeUndefined();
  });

  it("fails to open for a listener when core refuses it", async () => {
    const live = listen(() => {});
    const opening = live.open();
    newest().refuse();
    await expect(opening).rejects.toThrow();
  });

  it("is open again only once a dropped stream comes back", async () => {
    const live = listen(() => {});
    newest().open();
    newest().drop();
    let opened = false;
    const opening = live.open().then(() => (opened = true));
    await Promise.resolve();
    expect(opened).toBe(false);
    newest().open();
    await opening;
    expect(opened).toBe(true);
  });

  it("brings a stream waiting out its retry back for a listener that waits on it", () => {
    const live = listen(() => {});
    newest().refuse();
    expect(FakeEventSource.made).toHaveLength(1);
    void live.open().catch(() => {});
    expect(FakeEventSource.made).toHaveLength(2);
  });

  it("calls a gap when it opens after failing to, as it heard nothing meanwhile", () => {
    const gap = vi.fn();
    listen(() => {}, gap);
    newest().refuse();
    vi.advanceTimersByTime(2_000);
    newest().open();
    expect(gap).toHaveBeenCalledTimes(1);
  });

  it("calls a gap each time it comes back, never on its first open", () => {
    const gap = vi.fn();
    listen(() => {}, gap);
    newest().open();
    expect(gap).not.toHaveBeenCalled();
    newest().drop();
    newest().open();
    expect(gap).toHaveBeenCalledTimes(1);
  });

  it("tries again later when core refused it, and gaps once back", () => {
    const gap = vi.fn();
    listen(() => {}, gap);
    newest().open();
    newest().refuse();
    expect(FakeEventSource.made).toHaveLength(1);
    vi.advanceTimersByTime(2_000);
    expect(FakeEventSource.made).toHaveLength(2);
    newest().open();
    expect(gap).toHaveBeenCalledTimes(1);
  });

  it("closes once nobody listens", () => {
    const live = listenLive(() => {});
    const source = newest();
    live.close();
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });
});
