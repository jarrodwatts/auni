// Parse the whole command before booting. Help and typos never run a command.

interface Command {
  readonly summary: string;
  readonly synopsis?: string;
  readonly details?: string;
  /** A true flag takes a value, as in --version v0.1.2. */
  readonly flags: Readonly<Record<string, boolean>>;
  readonly words?: readonly string[];
}

const COMMANDS: Readonly<Record<string, Command>> = {
  "": {
    summary: "Start Auni and open it in your browser",
    synopsis: "[--no-open] [--no-web] [--no-jobs]",
    details: `  --no-open   Start without opening your browser.
  --no-web    Run only the API, for use with pnpm dev.
  --no-jobs   Run without background work (turns, watches, and moves).`,
    flags: { "--no-open": false, "--no-web": false, "--no-jobs": false },
  },
  demo: {
    summary: "Try Auni with fake money",
    synopsis: "[--first-run] [--port <n>] [--no-open] [--no-web] [--at <time>]",
    details: `Runs in a temporary folder with fake money and no login. Your real data is
untouched. Never send real money to a demo address.

  --first-run   Start from your first take, with an empty wallet and no history.
  --port <n>    Open the demo on this port (default 3939).
  --no-open     Print the demo link instead of opening your browser.
  --no-web      Run only the API.
  --at <time>   Freeze the demo clock at a timestamp (e.g. 2026-11-11T12:00:00Z).`,
    flags: {
      "--no-open": false,
      "--no-web": false,
      "--port": true,
      "--at": true,
      "--first-run": false,
    },
  },
  pair: {
    summary: "Get a one-time sign-in link",
    synopsis: "[--sign-out-everywhere | --channel <id>]",
    details: `The link works once and expires after 15 minutes.

  --sign-out-everywhere   Sign out every browser before creating a new link.
  --channel <id>          Pair a chat app such as Telegram instead.`,
    flags: { "--sign-out-everywhere": false, "--channel": true },
  },
  doctor: {
    summary: "Check Auni's health and see what to do next",
    synopsis: "[--fix | --dry-run] [--verbose | --json]",
    details: `  --verbose   Show every check, including technical details.
  --fix       Run the recommended repairs without asking.
  --dry-run   List possible repairs without making changes.
  --json      Print the full findings as JSON.

In a terminal, doctor asks about recommended repairs. With --verbose, it
also offers optional repairs. Repairs never touch your money, keys, or data.`,
    flags: { "--json": false, "--verbose": false, "--fix": false, "--dry-run": false },
  },
  triage: {
    summary: "Investigate a problem with your AI",
    synopsis: "[--brain <id>]",
    details: `Choose claude-code or codex with --brain. Your AI uses the doctor report,
Auni's logs, and its source to investigate and draft a GitHub issue. It asks
before changing or posting anything.`,
    flags: { "--brain": true },
  },
  setup: {
    summary: "Show the next setup step",
    synopsis: "[--json]",
    details: "Use --json for machine-readable output (for coding agents).",
    flags: { "--json": false },
  },
  stop: {
    summary: "Stop Auni after any moves in progress finish",
    flags: {},
  },
  up: {
    summary: "Keep Auni online for your devices over Tailscale",
    synopsis: "--always-on [--port <n>] [--json]",
    details: `Starts Auni on boot and makes it reachable from your other devices over
Tailscale. Asks once for permission to configure Tailscale Serve.

  --port <n>   Tailscale HTTPS port (default 443, or the next free port).
  --json       Print the setup status and required command as JSON.`,
    flags: { "--always-on": false, "--port": true, "--json": false },
  },
  service: {
    summary: "Manage Auni's background service",
    synopsis: "install|uninstall",
    details: `  install     Start Auni now and restart it automatically when you sign in.
  uninstall   Remove the background service without deleting your data.`,
    flags: {},
    words: ["install", "uninstall"],
  },
  export: {
    summary: "Save a backup of your takes, activity, and routines",
    synopsis: "[--to <file>]",
    details: `Saves your database and routines to the exports folder in your data
directory, or to --to <file>. Your wallet keys and settings stay on this
computer and are not included.`,
    flags: { "--to": true },
  },
  import: {
    summary: "Restore a backup into a fresh Auni",
    synopsis: "--from <file>",
    details: "Requires an empty Auni data folder or database (set AUNI_HOME or DATABASE_URL).",
    flags: { "--from": true },
  },
  "take-over": {
    summary: "Move Auni from another computer over Tailscale",
    synopsis: "--from <host> [--finish]",
    details: `Copy the command from Settings on the computer where Auni runs now.
It moves your database, settings, and wallet keys here, then stops the
other copy.

  --from <host>   The computer to move Auni from.
  --finish        Resume an interrupted move after the other computer says
                  Auni moved here.`,
    flags: { "--from": true, "--finish": false },
  },
  update: {
    summary: "Update Auni to the latest release",
    synopsis: "[--version <vX.Y.Z>] [--yes]",
    details: `Verifies the release signature, backs up your database, and checks that
the new version starts. If that check fails, Auni switches back automatically.

  --version <vX.Y.Z>   Install a specific release.
  --yes                Update without asking for confirmation.`,
    flags: { "--version": true, "--yes": false },
  },
  uninstall: {
    summary: "Remove Auni and keep your data",
    synopsis: "[--yes]",
    details: `Stops Auni and removes the app, command, and background service. Your
data stays on disk. Removing wallet keys always requires a separate
confirmation.

  --yes   Confirm uninstalling without prompting (never removes keys).`,
    flags: { "--yes": false },
  },
  build: {
    summary: "Build the web app",
    flags: {},
  },
  "--version": {
    summary: "Print your Auni version",
    flags: {},
  },
};

const GROUPS = [
  ["Start here", "", "demo", "doctor", "pair", "setup", "stop"],
  ["Devices", "up", "service", "take-over"],
  ["Maintenance", "update", "export", "import", "uninstall", "triage", "build", "--version"],
] as const;

const OVERVIEW_ARGS: Readonly<Record<string, string>> = {
  up: "--always-on",
  "take-over": "--from <host>",
  service: "install|uninstall",
};

export const USAGE = [
  "Usage: auni [command]",
  ...GROUPS.map(([heading, ...commands]) =>
    [
      heading,
      ...commands.map((command) => {
        const invocation = [command || "auni", OVERVIEW_ARGS[command]].filter(Boolean).join(" ");
        return `  ${invocation.padEnd(27)}${COMMANDS[command]!.summary}`.trimEnd();
      }),
    ].join("\n"),
  ),
  "Run auni <command> --help for options, or auni help start for startup flags.",
].join("\n\n");

/** What to run: a command with its flags (a value, or true for a switch) and its one word. */
export type Parsed =
  | {
      readonly command: string;
      readonly flags: ReadonlyMap<string, string | true>;
      readonly word?: string;
    }
  | { readonly help: string }
  | { readonly refused: string };

/** Reads `auni`'s arguments: bare flags are the start's, else the first word is the command. */
export function parseArgs(argv: readonly string[]): Parsed {
  const [first, ...after] = argv;
  if (first === "--help" || first === "-h" || (first === "help" && !after.length))
    return { help: USAGE };
  const name = first === "help" ? after[0] : first;
  const starts = name === undefined || (name.startsWith("-") && name !== "--version");
  const command = name === "start" && first === "help" ? "" : starts ? "" : name!;
  if (!Object.hasOwn(COMMANDS, command) || name === "")
    return { refused: `auni has no command "${name}".\n\nRun auni --help for commands.` };
  const spec = COMMANDS[command]!;
  const invocation = ["auni", command, spec.synopsis].filter(Boolean).join(" ");
  const own = [`Usage: ${invocation}`, `${spec.summary}.`, spec.details]
    .filter(Boolean)
    .join("\n\n");
  if (first === "help") return { help: own };
  const rest = starts ? argv : after;
  const flags = new Map<string, string | true>();
  let word: string | undefined;
  for (let at = 0; at < rest.length; at++) {
    const arg = rest[at]!;
    if (arg === "--help" || arg === "-h") return { help: own };
    if (word === undefined && spec.words?.includes(arg)) word = arg;
    else if (!Object.hasOwn(spec.flags, arg))
      return {
        refused: `${["auni", command].filter(Boolean).join(" ")} doesn't take ${arg}.\n\n${own}`,
      };
    else if (!spec.flags[arg]) flags.set(arg, true);
    else {
      const value = rest[++at];
      if (value === undefined || value.startsWith("-"))
        return { refused: `${arg} needs a value.\n\n${own}` };
      flags.set(arg, value);
    }
  }
  if (spec.words && word === undefined) return { refused: own };
  return { command, flags, ...(word ? { word } : {}) };
}
