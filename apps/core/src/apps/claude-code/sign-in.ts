import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

import { scratchDir } from "../../agent/box.ts";
import type { SignInAttempt } from "../contract.ts";
import { claudeCli } from "./cli.ts";
import { childEnv } from "./options.ts";

/** As much of what the CLI printed as the owner's terminal view keeps. */
const OUTPUT_CHARS = 8_000;

/**
 * Claude Code's own sign-in, `claude auth login`, run on this machine with the page drawing its
 * terminal. With no terminal attached it speaks plain lines: it prints the sign-in page's address
 * and "Paste code here if prompted >", then reads one line, the code that page gives the owner on
 * whichever device they opened it. That line goes to the CLI's prompt and nowhere else: the CLI
 * prints no echo of it, so what the owner sees is only ever the CLI's own words. It keeps the
 * login it gets in its own store, which every turn's CLI reads.
 */
export async function signIn({ signal, show, onTyped }: SignInAttempt): Promise<void> {
  const child = spawn(claudeCli(), ["auth", "login", "--claudeai"], {
    env: childEnv(),
    cwd: scratchDir(),
    stdio: ["pipe", "pipe", "pipe"],
    signal,
  });
  let output = "";
  const print = (text: string) => {
    output = (output + text).slice(-OUTPUT_CHARS);
    show({ kind: "terminal", command: "claude auth login", output });
  };
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (data: string) => print(stripVTControlCharacters(data)));
  }
  // A line typed after it exited; `close` says how it ended.
  child.stdin.on("error", () => {});
  onTyped((line) => {
    child.stdin.write(`${line}\n`);
    // Where a terminal would echo what was typed, the next words start on a line of their own.
    print("\n");
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code === 0) return;
  const last = output.trim().split("\n").at(-1)?.trim();
  throw new Error(last || "Claude Code's sign-in stopped before it finished.");
}
