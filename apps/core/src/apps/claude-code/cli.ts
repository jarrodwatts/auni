import { createRequire } from "node:module";
import { arch, platform } from "node:os";

/**
 * The Claude Code Auni's Agent SDK bundles, which every turn runs, found as the SDK finds it: the
 * one that says who is signed in and signs them in (sign-in.ts). It keeps one login with the
 * owner's own `claude`, so this works before they install one.
 */
export function claudeCli(): string {
  const resolve = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk")).resolve;
  const kinds =
    platform() === "linux"
      ? [`linux-${arch()}`, `linux-${arch()}-musl`]
      : [`${platform()}-${arch()}`];
  for (const kind of kinds) {
    try {
      return resolve(`@anthropic-ai/claude-agent-sdk-${kind}/claude`);
    } catch {
      // Not this one: the next.
    }
  }
  throw new Error("The Claude Code Auni bundles isn't installed: run Auni's install again.");
}
