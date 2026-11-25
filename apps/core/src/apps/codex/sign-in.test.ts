import { chmodSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { tempDir } from "../../test/temp-dir.ts";
import type { SignInShows } from "../contract.ts";
import { signIn } from "./sign-in.ts";

/**
 * A stand-in `codex` on the PATH whose app server runs a device sign-in as the real one did on
 * this machine (codex-cli 0.164.0): account/login/start answers with OpenAI's page and a code,
 * then account/login/completed comes once the owner entered it there, as `outcome` says.
 */
function codexWhoseSignIn(outcome: { success: boolean; error?: string }): string {
  const dir = tempDir("auni-codex-");
  const script = `#!/usr/bin/env node
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (method === "initialize") send({ id, result: { userAgent: "codex" } });
  if (method === "account/login/start" && params.type === "chatgptDeviceCode") {
    send({ id, result: { type: "chatgptDeviceCode", loginId: "L1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-12345" } });
    send({ method: "account/login/completed", params: { loginId: "L0", success: true } });
    setTimeout(() => send({ method: "account/login/completed", params: { loginId: "L1", ...${JSON.stringify(outcome)} } }), 20);
  }
});
`;
  writeFileSync(join(dir, "codex"), script);
  chmodSync(join(dir, "codex"), 0o755);
  return [dir, dirname(process.execPath)].join(delimiter);
}

const path = process.env.PATH;
afterEach(() => {
  process.env.PATH = path;
});

async function signInWith(outcome: { success: boolean; error?: string }) {
  process.env.PATH = codexWhoseSignIn(outcome);
  const shown: SignInShows[] = [];
  const ended = await signIn({
    signal: new AbortController().signal,
    show: (view) => shown.push(view),
    onTyped: () => {},
  }).then(
    () => "signed in",
    (error: Error) => error.message,
  );
  return { ended, shown };
}

describe.runIf(process.platform !== "win32")("Codex's sign-in from the web app", () => {
  it("shows OpenAI's page and the code, and is done when Codex says this sign-in is", async () => {
    expect(await signInWith({ success: true })).toEqual({
      ended: "signed in",
      shown: [{ kind: "code", url: "https://auth.openai.com/codex/device", code: "ABCD-12345" }],
    });
  });

  it("fails in Codex's own words", async () => {
    const { ended } = await signInWith({ success: false, error: "Login was not completed" });
    expect(ended).toBe("Login was not completed");
  });
});
