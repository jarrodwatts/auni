import { afterEach, describe, expect, it, vi } from "vitest";

import type { Brain, BrainCheck, SignInAttempt } from "../apps/contract.ts";

/** One brain whose sign-in this test plays, and whose next check it chooses. */
const world = vi.hoisted(() => ({
  attempt: null as SignInAttempt | null,
  finish: (_error?: Error) => {},
  check: { ready: true, login: "your plan" } as BrainCheck,
  published: 0,
}));

vi.mock("../apps/registry.ts", () => {
  const brain: Partial<Brain> = {
    signIn: (attempt) =>
      new Promise<void>((resolve, reject) => {
        world.attempt = attempt;
        world.finish = (error) => (error ? reject(error) : resolve());
        attempt.signal.addEventListener("abort", () => reject(new Error("killed")));
      }),
  };
  return { brains: () => [{ about: { id: "cli", name: "The CLI" }, brain }] };
});
vi.mock("./brain.ts", () => ({ checkAfresh: () => Promise.resolve(world.check) }));
vi.mock("../conversation/stream.ts", () => ({ publishBrains: () => void world.published++ }));

const { brainTask, signInFields, startInstall, startSignIn, stopTask } =
  await import("./sign-in.ts");

/** Lets the sign-in's promise chain run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  stopTask("cli");
  world.check = { ready: true, login: "your plan" };
});

describe("signing a brain in from the web app", () => {
  it("shows the CLI's prompt, takes the owner's line by a private field, and is gone once ready", async () => {
    const typed: string[] = [];
    expect(startSignIn("cli")).toBe(true);
    expect(brainTask("cli")).toEqual({ kind: "signing-in", view: null });
    // One sign-in at a time, whichever device asks.
    expect(startSignIn("cli")).toBe(false);
    expect(signInFields()).toEqual([]);

    world.attempt!.onTyped((line) => typed.push(line));
    world.attempt!.show({ kind: "terminal", command: "cli login", output: "Paste code here > " });
    expect(brainTask("cli")).toEqual({
      kind: "signing-in",
      view: {
        kind: "terminal",
        command: "cli login",
        output: "Paste code here > ",
        field: "cli-sign-in",
      },
    });
    const [field] = signInFields();
    expect(field!.id).toBe("cli-sign-in");
    expect(await field!.accept({ line: "  code#state \n" })).toBeNull();
    expect(typed).toEqual(["code#state"]);

    const before = world.published;
    world.finish();
    await settle();
    expect(brainTask("cli")).toBeNull();
    expect(signInFields()).toEqual([]);
    expect(world.published).toBeGreaterThan(before);
  });

  it("stays failed in the CLI's own words until the owner signs in again", async () => {
    startSignIn("cli");
    world.finish(new Error("Login failed: That code wasn't accepted."));
    await settle();
    expect(brainTask("cli")).toEqual({
      kind: "failed",
      said: "Login failed: That code wasn't accepted.",
    });
    expect(startSignIn("cli")).toBe(true);
    expect(brainTask("cli")).toEqual({ kind: "signing-in", view: null });
  });

  it("says so when the CLI finished but its check still doesn't see a login", async () => {
    world.check = { ready: false, why: "signed-out", fix: "cli login" };
    startSignIn("cli");
    world.finish();
    await settle();
    expect(brainTask("cli")).toMatchObject({ kind: "failed" });
  });

  it("is gone at once when the owner stops it, and the CLI with it", async () => {
    startSignIn("cli");
    const { signal } = world.attempt!;
    stopTask("cli");
    expect(signal.aborted).toBe(true);
    await settle();
    expect(brainTask("cli")).toBeNull();
  });

  it("stops a sign-in nobody finishes, saying why", async () => {
    vi.useFakeTimers();
    try {
      startSignIn("cli");
      await vi.advanceTimersByTimeAsync(15 * 60_000);
      expect(brainTask("cli")).toMatchObject({
        kind: "failed",
        said: expect.stringContaining("within 15 minutes") as string,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers no install for a brain with none", () => {
    expect(startInstall("cli")).toBe(false);
    expect(startSignIn("nobody")).toBe(false);
  });
});
