import { defineApp } from "../contract.ts";
import { check, secrets } from "./check.ts";
import about from "./about.ts";
import { run } from "./run.ts";
import { terminal } from "./terminal.ts";
import { signIn } from "./sign-in.ts";

/** The owner's own Claude Code, through the Claude Agent SDK, run on this machine in Auni's box. */
export default defineApp({
  about,
  brain: {
    check,
    run,
    secrets,
    terminal,
    signIn,
    computer:
      "a sandboxed shell on the owner's own computer with a scratch folder, web search and the public internet",
    models: "Anthropic's Claude models",
  },
});
