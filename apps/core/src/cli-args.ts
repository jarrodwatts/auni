// What `auni` takes on its command line (cli.ts runs it). Each command lists the flags it knows,
// and anything else is refused with that command's usage before it does anything: a mistyped or
// unknown flag never runs a command as if it weren't there, and `--help` after one is its help.

interface Command {
  /** Its lines in `auni --help`. */
  readonly usage: string;
  /** The flags it takes: true for one followed by a value (`--version v0.1.2`). */
  readonly flags: Readonly<Record<string, boolean>>;
  /** The words it takes in place of flags (`service install`). */
  readonly words?: readonly string[];
}

const COMMANDS: Readonly<Record<string, Command>> = {
  "": {
    usage: `  auni [--no-open] [--no-web] [--no-jobs]
                                 Start Auni: its database, the API, its jobs and the web app,
                                 then open it in your browser (the first time, signed in as
                                 yours). --no-open only says where it is; --no-web leaves the
                                 web app to \`next dev\` (pnpm dev); --no-jobs runs nothing in
                                 the background, as auni update does to see a version come up.`,
    flags: { "--no-open": false, "--no-web": false, "--no-jobs": false },
  },
  demo: {
    usage: `  demo [--no-open] [--no-web] [--port <n>] [--at <moment>] [--first-run]
                                 Start a demo of Auni: the whole app in a throwaway home, with a
                                 made-up owner, a scripted AI and a stand-in wallet and chains, so
                                 it needs no login, calls no model and moves no money. Nothing
                                 of yours is read or changed. --port is the web app's (3939).
                                 --at stops the demo's clock at a moment (2026-11-11T12:00:00Z),
                                 so every run shows the same thing: for pictures to compare.
                                 --first-run starts it as a new owner's first run instead, with
                                 no past and no money.`,
    flags: {
      "--no-open": false,
      "--no-web": false,
      "--port": true,
      "--at": true,
      "--first-run": false,
    },
  },
  pair: {
    usage: `  pair [--sign-out-everywhere]   Print a one-time link that pairs a browser as Auni's owner.
  pair --channel <id>            Print the code that pairs you on a channel (telegram).`,
    flags: { "--sign-out-everywhere": false, "--channel": true },
  },
  doctor: {
    usage: `  doctor [--fix | --dry-run] [--json]
                                 Check the version, the database, jobs, the service, chains' RPCs,
                                 the brain, the wallet and the web app, and say what to fix. Where
                                 a safe repair exists (the service, its start at boot, a restart)
                                 it asks about each; --fix runs the recommended ones unasked, and
                                 --dry-run only says what they are. None touches keys or money.`,
    flags: { "--json": false, "--fix": false, "--dry-run": false },
  },
  triage: {
    usage: `  triage [--brain <id>]          Start your own Claude Code or Codex (--brain claude-code or codex)
                                 in this terminal to find out with you what's wrong with Auni, and
                                 write it up as an issue for Auni's GitHub. It reads what auni
                                 doctor finds, Auni's output and its source, never your keys or
                                 settings, and asks before it changes or posts anything.`,
    flags: { "--brain": true },
  },
  setup: {
    usage: `  setup [--json]                 What to do next to get Auni running and open in your browser,
                                 one step at a time, for you or a coding agent.`,
    flags: { "--json": false },
  },
  stop: {
    usage: `  stop                           Stop the Auni running on this computer, whatever started it (a
                                 terminal, the background or the service), letting running moves
                                 finish first, as Ctrl-C does.`,
    flags: {},
  },
  up: {
    usage: `  up --always-on [--port <n>] [--json]
                                 Make this machine Auni's always-on home, reached from your own
                                 devices through Tailscale: Auni answers only this machine's
                                 Tailscale account, runs as a service started at boot, and
                                 \`tailscale serve\` sends https to it on --port, or on 443 or
                                 the next port free there, which its address says.
                                 It asks for root once, for \`tailscale serve\`; with --json it
                                 asks nothing and says what to run. Safe to run again.`,
    flags: { "--always-on": false, "--port": true, "--json": false },
  },
  service: {
    usage: `  service install|uninstall      Run Auni as a service of this machine (systemd or launchd),
                                 started at login and again if it stops (hosts/).`,
    flags: {},
    words: ["install", "uninstall"],
  },
  export: {
    usage: `  export [--to <file>]           Write everything Auni keeps (every row of its database, and your
                                 routines) to one file, into the data folder's exports/ unless
                                 --to names another. Not your wallet's keys or your settings.`,
    flags: { "--to": true },
  },
  import: {
    usage: `  import --from <file>           Load an export into a database Auni has never used: a new
                                 AUNI_HOME, or a DATABASE_URL naming an empty database.`,
    flags: { "--from": true },
  },
  "take-over": {
    usage: `  take-over --from <address> [--finish]
                                 Take Auni over here from your laptop, over Tailscale: its
                                 database, your settings and your wallet's keys, with the code in
                                 AUNI_HANDOVER_CODE. The command comes from Settings on the
                                 laptop, whose Auni then stops for good; then Auni is set up here
                                 to stay on. --finish completes one cut off midway, when the
                                 laptop can't be asked again and its page says Auni moved here.`,
    flags: { "--from": true, "--finish": false },
  },
  update: {
    usage: `  update [--version <vX>] [--yes]
                                 Check the newest release (or vX) is signed by Auni's release
                                 key, say what changed and ask; then stop Auni, build it beside
                                 this one and switch to it once it comes up, with the database
                                 exported and copied first; back to this one, data and all, if
                                 it doesn't; then start Auni again as it ran. --yes answers yes,
                                 for when you've read what it is.`,
    flags: { "--version": true, "--yes": false },
  },
  uninstall: {
    usage: `  uninstall [--yes]              Stop Auni, then remove its app, its command and its service,
                                 once you say yes (--yes answers it). Your data stays, and your
                                 wallet's keys unless you type that you want them gone.`,
    flags: { "--yes": false },
  },
  build: {
    usage: `  build                          Build the web app now, as starting would first (an image does).`,
    flags: {},
  },
  "--version": {
    usage: `  --version                      The version of Auni this is.`,
    flags: {},
  },
};

export const USAGE = `Usage: auni [command]\n\n${Object.values(COMMANDS)
  .map(({ usage }) => usage)
  .join("\n")}`;

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
  if (first === "help" || first === "--help" || first === "-h") return { help: USAGE };
  const starts = first === undefined || (first.startsWith("-") && first !== "--version");
  if (!starts && (first === "" || !Object.hasOwn(COMMANDS, first!)))
    return { refused: `auni has no command "${first}".\n\n${USAGE}` };
  const command = starts ? "" : first!;
  const spec = COMMANDS[command]!;
  const own = `Usage:\n${spec.usage}`;
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
