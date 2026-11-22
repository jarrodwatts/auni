import { existsSync } from "node:fs";

import { codexCommand } from "./options.ts";

/** A TOML string, which a JSON string of a path always is. */
const toml = (value: string) => JSON.stringify(value);

/**
 * The owner's own `codex`, in their terminal on their own login and settings, for `auni triage`:
 * its sandbox can't read `hidden`, writes nothing, and reaches the network (GitHub, the source),
 * so every command that changes something is one Codex asks to run outside it first. It is the
 * codex a turn runs: on their PATH, else the one Auni installed in its tools folder.
 */
export function terminal(prompt: string, hidden: readonly string[]): readonly string[] | null {
  const command = codexCommand();
  if (!command) return null;
  // Codex refuses a rule for a path that isn't there.
  const filesystem = hidden
    .filter((path) => existsSync(path))
    .map((path) => `${toml(path)}="deny"`);
  return [
    command,
    ...[
      `default_permissions="triage"`,
      `permissions.triage.extends=":read-only"`,
      `permissions.triage.filesystem={${filesystem.join(",")}}`,
      `permissions.triage.network.enabled=true`,
    ].flatMap((setting) => ["-c", setting]),
    prompt,
  ];
}
