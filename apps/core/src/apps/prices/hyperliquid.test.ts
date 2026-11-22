import { describe, expect, it } from "vitest";

import ticks from "./fixtures/allmids-ticks.json";
import { dexOf, intervalFor, openMids } from "./hyperliquid.ts";

/** A socket that says what was sent, and hands on what the test makes Hyperliquid send. */
class FakeSocket extends EventTarget {
  readyState = 0;
  readonly sent: unknown[] = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
  say(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
  drop() {
    this.dispatchEvent(new Event("close"));
  }
}

describe("Hyperliquid's mid prices", () => {
  it("subscribes each dex a watch needs, and hands on each allMids message as a tick", async () => {
    const socket = new FakeSocket();
    const stream = openMids(new AbortController().signal, () => socket as unknown as WebSocket);
    stream.subscribe("");
    stream.subscribe("xyz");
    stream.subscribe("xyz");
    socket.open();
    expect(socket.sent).toEqual([
      { method: "subscribe", subscription: { type: "allMids" } },
      { method: "subscribe", subscription: { type: "allMids", dex: "xyz" } },
    ]);

    socket.say({ channel: "subscriptionResponse", data: {} });
    socket.say(ticks[0]);
    socket.say(ticks[1]);
    socket.drop();
    const seen: Record<string, number>[] = [];
    await expect(
      (async () => {
        for await (const tick of stream.ticks()) seen.push({ ...tick.mids });
      })(),
    ).rejects.toThrow("closed");
    expect(seen).toEqual([{ BTC: 79_673.5, ETH: 2_389.65 }, { "xyz:NVDA": 196.885 }]);
    expect(socket.readyState).toBe(3);
  });

  it("ends quietly when Auni stops it", async () => {
    const socket = new FakeSocket();
    const stop = new AbortController();
    const stream = openMids(stop.signal, () => socket as unknown as WebSocket);
    const next = stream.ticks().next();
    stop.abort();
    expect(await next).toEqual({ done: true, value: undefined });
  });
});

describe("markets and candles", () => {
  it("know a market's dex", () => {
    expect(dexOf("BTC")).toBe("");
    expect(dexOf("xyz:NVDA")).toBe("xyz");
  });

  it("read a long sleep in candles big enough that Hyperliquid still keeps them", () => {
    const now = Date.parse("2026-11-06T00:00:00Z");
    const hours = (count: number) => now - count * 3_600_000;
    expect(intervalFor(hours(8), now)[0]).toBe("1m");
    expect(intervalFor(hours(5 * 24), now)[0]).toBe("5m");
    expect(intervalFor(hours(40 * 24), now)[0]).toBe("15m");
    expect(intervalFor(hours(300 * 24), now)[0]).toBe("4h");
  });
});
