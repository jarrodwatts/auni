import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { onStopAsked, whileBooting } from "./ctrl-c.ts";

const initialExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = initialExitCode;
  vi.restoreAllMocks();
});

describe("onStopAsked", () => {
  it("stops gently with 0 on every SIGTERM, so auni stop asked twice cuts nothing short", () => {
    const signals = new EventEmitter();
    const stop = vi.fn();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    onStopAsked(stop, signals);
    signals.emit("SIGTERM");
    signals.emit("SIGTERM");
    expect(stop).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenNthCalledWith(1, 0);
    expect(stop).toHaveBeenNthCalledWith(2, 0);
    expect(exit).not.toHaveBeenCalled();
  });

  it("stops gently with 0 when its terminal window closes, so its Postgres stops with it", () => {
    const signals = new EventEmitter();
    const stop = vi.fn();
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    onStopAsked(stop, signals);
    signals.emit("SIGHUP");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith(0);
    expect(exit).not.toHaveBeenCalled();
    // The closed terminal refusing a write is no reason to die before Postgres is stopped.
    expect(() => process.stdout.emit("error", new Error("EIO"))).not.toThrow();
  });

  it("stops gently with 130 on Ctrl-C, and forces exit on a second press a second later", () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      const signals = new EventEmitter();
      const stop = vi.fn();
      const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
      onStopAsked(stop, signals);
      signals.emit("SIGINT");
      vi.advanceTimersByTime(999);
      signals.emit("SIGINT");
      expect(exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      signals.emit("SIGINT");
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop).toHaveBeenCalledWith(130);
      expect(exit).toHaveBeenCalledWith(130);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes its listeners when unsubscribed", () => {
    const signals = new EventEmitter();
    const stop = vi.fn();
    const off = onStopAsked(stop, signals);
    off();
    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    signals.emit("SIGHUP");
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("whileBooting", () => {
  it("aborts boot, releases a held database, and exits quietly with 130 on Ctrl-C", async () => {
    const signals = new EventEmitter();
    const release = vi.fn(async () => {});
    const onStop = vi.fn();

    await whileBooting(
      async (booting) => {
        booting.hold({ release });
        signals.emit("SIGINT");
        expect(booting.signal.aborted).toBe(true);
        throw new Error("cancelled mid-boot");
      },
      { signals, onStop },
    );

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(130);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("exits quietly with 0 on SIGTERM during boot", async () => {
    const signals = new EventEmitter();
    const release = vi.fn(async () => {});

    await whileBooting(
      async (booting) => {
        booting.hold({ release });
        signals.emit("SIGTERM");
        throw new Error("cancelled by SIGTERM");
      },
      { signals },
    );

    expect(release).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(0);
  });

  it("rethrows real failures when not interrupted, after releasing any held database", async () => {
    const signals = new EventEmitter();
    const release = vi.fn(async () => {});

    await expect(
      whileBooting(
        async (booting) => {
          booting.hold({ release });
          throw new Error("disk full");
        },
        { signals },
      ),
    ).rejects.toThrow("disk full");

    expect(release).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("detaches listeners and leaves the database with start() once handed off", async () => {
    const signals = new EventEmitter();
    const release = vi.fn(async () => {});

    await whileBooting(
      async (booting) => {
        booting.hold({ release });
        return booting.handOff(
          Promise.resolve().then(() => {
            expect(signals.listenerCount("SIGINT")).toBe(0);
            expect(signals.listenerCount("SIGTERM")).toBe(0);
          }),
        );
      },
      { signals },
    );

    expect(release).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(initialExitCode);
  });
});
