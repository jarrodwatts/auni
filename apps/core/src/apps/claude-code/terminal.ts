import { onPath } from "./check.ts";
import { claudeCli } from "./cli.ts";

/**
 * The owner's own `claude`, in their terminal on their own login and settings, for `auni
 * triage`: its permission rules deny its file tools `hidden`, folders and all (a rule holds the
 * Read and Edit tools, not what a shell command opens, which the playbook covers), and every
 * command and edit their own rules don't already allow is asked first, whatever mode they keep.
 * Their own `claude` where it's on the PATH, else the one Auni bundles, which every turn runs.
 */
export function terminal(prompt: string, hidden: readonly string[]): readonly string[] | null {
  const command = onPath("claude") ? "claude" : bundled();
  if (!command) return null;
  // "//" starts an absolute path in a permission rule.
  const deny = hidden.flatMap((path) =>
    ["Read", "Edit"].flatMap((tool) => [`${tool}(/${path})`, `${tool}(/${path}/**)`]),
  );
  const settings = JSON.stringify({ permissions: { deny } });
  return [command, "--permission-mode", "default", "--settings", settings, prompt];
}

function bundled(): string | null {
  try {
    return claudeCli();
  } catch {
    return null;
  }
}
