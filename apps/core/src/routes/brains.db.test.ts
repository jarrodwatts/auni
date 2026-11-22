import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Brain, SignInAttempt } from "../apps/contract.ts";
import { serve } from "../test/serve.ts";
import { brainsRouter } from "./brains.ts";
import { privateRouter } from "./private.ts";

/**
 * One brain whose sign-in is a prompt that takes one line, standing in for Claude Code's: what
 * the owner types there goes in by the private field and reaches the prompt, and nothing else.
 */
const world = vi.hoisted(() => ({
  typed: [] as string[],
  attempt: null as SignInAttempt | null,
  signedIn: false,
}));
vi.mock("../apps/registry.ts", async (original) => {
  const brain: Partial<Brain> = {
    signIn: (attempt) =>
      new Promise<void>((resolve, reject) => {
        world.attempt = attempt;
        attempt.show({
          kind: "terminal",
          command: "cli login",
          output: "Paste code here if prompted > ",
        });
        attempt.onTyped((line) => {
          world.typed.push(line);
          world.signedIn = true;
          resolve();
        });
        attempt.signal.addEventListener("abort", () => reject(new Error("stopped")));
      }),
  };
  return {
    ...(await original<object>()),
    brains: () => [{ about: { id: "cli", name: "The CLI" }, brain }],
  };
});
vi.mock("../agent/brain.ts", async (original) => ({
  ...(await original<object>()),
  brainRows: async () => [
    world.signedIn
      ? {
          id: "cli",
          name: "The CLI",
          state: "ready",
          login: "your plan",
          signedInAs: "sam@example.com",
          models: [],
        }
      : { id: "cli", name: "The CLI", state: "signed-out", fix: "cli login" },
  ],
  checkAfresh: async () => ({ ready: world.signedIn, login: "your plan" }),
}));

const url = serve(express().use("/brains", brainsRouter).use("/private", privateRouter));

// The line the owner types, which must reach the CLI's prompt and show up nowhere else.
const CODE = "sign-in-code-6f1e2a#state-93b0";

let logged = "";
beforeEach(() => {
  logged = "";
  world.typed = [];
  world.signedIn = false;
  for (const level of ["log", "info", "warn", "error", "debug", "trace"] as const)
    vi.spyOn(console, level).mockImplementation((...said: unknown[]) => {
      logged += `${said.map(String).join(" ")}\n`;
    });
});
afterEach(() => vi.restoreAllMocks());

const call = async (method: string, path: string, body?: unknown) => {
  const response = await fetch(url(path), {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  expect(text).not.toContain(CODE);
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
};

describe("signing the owner's AI in from the web app", () => {
  it("starts the CLI's sign-in, takes the owner's line to its prompt alone, and lands ready", async () => {
    const before = await call("GET", "/brains");
    expect(before.body).toMatchObject({
      rows: [
        {
          row: { id: "cli", state: "signed-out" },
          task: null,
          canInstall: false,
          canSignIn: true,
        },
      ],
      blocked: null,
      machine: expect.any(String) as string,
    });

    const started = await call("POST", "/brains/cli/sign-in");
    expect(started.body.rows).toMatchObject([
      {
        task: {
          kind: "signing-in",
          view: {
            kind: "terminal",
            command: "cli login",
            output: "Paste code here if prompted > ",
            field: "cli-sign-in",
          },
        },
      },
    ]);
    expect((await call("POST", "/brains/cli/sign-in")).status).toBe(409);

    const typed = await call("POST", "/private/cli-sign-in", { values: { line: CODE } });
    expect(typed).toEqual({ status: 200, body: { said: null } });
    expect(world.typed).toEqual([CODE]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const after = await call("GET", "/brains");
    expect(after.body.rows).toEqual([
      {
        row: {
          id: "cli",
          name: "The CLI",
          state: "ready",
          login: "your plan",
          signedInAs: "sam@example.com",
          models: [],
        },
        task: null,
        canInstall: false,
        canSignIn: false,
      },
    ]);
    // Its field is gone with the prompt, so a second line goes nowhere.
    expect((await call("POST", "/private/cli-sign-in", { values: { line: CODE } })).status).toBe(
      404,
    );
    expect(logged).not.toContain(CODE);
  });

  it("stops a sign-in the owner puts away, and the CLI with it", async () => {
    await call("POST", "/brains/cli/sign-in");
    const { signal } = world.attempt!;
    const stopped = await call("DELETE", "/brains/cli/task");
    expect(signal.aborted).toBe(true);
    expect(stopped.body.rows).toMatchObject([{ task: null, canSignIn: true }]);
  });
});
