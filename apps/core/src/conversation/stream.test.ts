import { afterEach, describe, expect, it, vi } from "vitest";

import { onLive, publishThreadEvent, type LiveMessage } from "./stream.ts";

const offs: (() => void)[] = [];
const listen = (listener: (message: LiveMessage) => void) => offs.push(onLive(listener));
afterEach(() => offs.splice(0).forEach((off) => off()));

const progress = (turnId: string) => ({ kind: "progress", turnId, stage: "thinking" }) as const;

describe("live messages", () => {
  it("reach every listener, in the order they were published", () => {
    const first: string[] = [];
    const second: string[] = [];
    const turnOf = (message: LiveMessage) =>
      message.topic === "thread" && "turnId" in message.event ? message.event.turnId : "";
    listen((message) => first.push(turnOf(message)));
    listen((message) => second.push(turnOf(message)));
    publishThreadEvent("t", progress("a"));
    publishThreadEvent("t", progress("b"));
    expect(first).toEqual(["a", "b"]);
    expect(second).toEqual(["a", "b"]);
  });

  it("stop reaching a listener once it stops listening", () => {
    const heard = vi.fn();
    onLive(heard)();
    publishThreadEvent("t", progress("a"));
    expect(heard).not.toHaveBeenCalled();
  });

  // A broken tab's stream must never fail the turn that is publishing.
  it("still reach the rest when one listener throws", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const heard = vi.fn();
    listen(() => {
      throw new Error("socket gone");
    });
    listen(heard);
    expect(() => publishThreadEvent("t", progress("a"))).not.toThrow();
    expect(heard).toHaveBeenCalledWith({ topic: "thread", threadId: "t", event: progress("a") });
  });
});
