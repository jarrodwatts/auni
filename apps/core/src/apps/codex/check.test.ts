import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { tempDir } from "../../test/temp-dir.ts";
import { check } from "./check.ts";

/**
 * A stand-in `codex` on the PATH whose app server answers as the real one did on this machine
 * (codex-cli 0.164.0): `account` is account/read's account, `authMethod` getAuthStatus's.
 */
function codexThatSays(said: { account: unknown; authMethod: string | null }): string {
  const dir = tempDir("auni-codex-");
  const answers = {
    initialize: { userAgent: "codex" },
    "account/read": { account: said.account, requiresOpenaiAuth: true },
    getAuthStatus: { authMethod: said.authMethod, authToken: null, requiresOpenaiAuth: true },
    "model/list": { data: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", isDefault: true }] },
  };
  const script = `#!/usr/bin/env node
const answers = ${JSON.stringify(answers)};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id !== undefined) process.stdout.write(JSON.stringify({ id, result: answers[method] }) + "\\n");
});
`;
  writeFileSync(join(dir, "codex"), script);
  chmodSync(join(dir, "codex"), 0o755);
  return [dir, dirname(process.execPath)].join(delimiter);
}

const path = process.env.PATH;
const home = process.env.AUNI_HOME;
afterEach(() => {
  process.env.PATH = path;
  if (home === undefined) delete process.env.AUNI_HOME;
  else process.env.AUNI_HOME = home;
});

const run = () => check(new AbortController().signal);

describe.runIf(process.platform !== "win32")("the Codex check", () => {
  it("is ready on a login it can use, and names the plan", async () => {
    process.env.PATH = codexThatSays({
      account: { type: "chatgpt", email: null, planType: "pro" },
      authMethod: "chatgpt",
    });
    expect(await run()).toMatchObject({
      ready: true,
      login: "your ChatGPT Pro plan",
      models: [expect.objectContaining({ id: "gpt-6.1-sol", isDefault: true })],
    });
  });

  it("names the account a ChatGPT login is signed in as", async () => {
    process.env.PATH = codexThatSays({
      account: { type: "chatgpt", email: "sam@example.com", planType: "plus" },
      authMethod: "chatgpt",
    });
    expect(await run()).toMatchObject({
      ready: true,
      login: "your ChatGPT Plus plan",
      signedInAs: "sam@example.com",
      models: [expect.objectContaining({ id: "gpt-6.1-sol", isDefault: true })],
    });
  });

  it("finds the Codex Auni installed in its tools folder, when the PATH has none", async () => {
    const [dir, node] = codexThatSays({ account: null, authMethod: null }).split(delimiter);
    process.env.AUNI_HOME = join(tempDir("auni-home-"), ".auni");
    process.env.PATH = node!;
    expect(await run()).toMatchObject({
      why: "not-installed",
      fix: "npm install -g @openai/codex",
    });
    mkdirSync(`${process.env.AUNI_HOME}-tools/bin`, { recursive: true });
    renameSync(join(dir!, "codex"), `${process.env.AUNI_HOME}-tools/bin/codex`);
    expect(await run()).toMatchObject({ why: "signed-out" });
  });

  it("tells a machine never signed in to sign in", async () => {
    process.env.PATH = codexThatSays({ account: null, authMethod: null });
    expect(await run()).toEqual({
      ready: false,
      why: "signed-out",
      fix: "codex login --device-auth",
    });
  });

  // `codex login status` still says "Logged in using ChatGPT" then; only the app server knows.
  it("says a sign-in whose refresh token expired has expired", async () => {
    process.env.PATH = codexThatSays({ account: null, authMethod: "chatgpt" });
    expect(await run()).toEqual({ ready: false, why: "expired", fix: "codex login --device-auth" });
  });
});
