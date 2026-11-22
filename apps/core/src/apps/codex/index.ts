import { defineApp } from "../contract.ts";
import { check, secrets } from "./check.ts";
import about from "./about.ts";
import { install } from "./install.ts";
import { run } from "./run.ts";
import { terminal } from "./terminal.ts";
import { signIn } from "./sign-in.ts";

/** The owner's own Codex, through `codex app-server`, run on this machine in Auni's box. */
export default defineApp({
  about,
  brain: {
    check,
    run,
    secrets,
    terminal,
    signIn,
    install,
    // Its shell is read-only with no network (options.ts); web search runs outside it.
    computer:
      "a read-only sandboxed shell on the owner's own computer, with web search; the shell itself has no internet, so read pages and APIs with fetch_url",
    models: "OpenAI's GPT models",
  },
});
