import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";

import { boot, letGo, withDatabase } from "./boot.ts";
import { readSettings } from "./settings.ts";
import { parseArgs } from "./cli-args.ts";
import type { KeysChoice } from "./release/uninstall.ts";

// `auni <command>` (bin/auni.mjs, or `pnpm auni <command>` from the repo). Nothing here imports
// env.ts before boot() has readied the environment it reads.

// Node tries each of a host's addresses for 250 ms before the next. Where IPv6 has no working
// route and an IPv4 connect takes longer than that, every call to a host with both fails in
// under a second (Telegram's, on a machine checked in November 2026): each address gets 2.5 s.
setDefaultAutoSelectFamilyAttemptTimeout(2_500);

// A command's help, or a flag it doesn't take, runs nothing (cli-args.ts).
const parsed = parseArgs(process.argv.slice(2));
if ("help" in parsed) console.log(parsed.help);
if ("refused" in parsed) {
  console.error(parsed.refused);
  process.exitCode = 2;
}
const { command, flags, word } =
  "command" in parsed
    ? parsed
    : { command: null, flags: new Map<string, string | true>(), word: null };

/** The owner's answer to `question`, typed in this terminal. */
async function askInTerminal(question: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await terminal.question(question);
  terminal.close();
  return answer;
}

/** What a command asks before it changes this machine: yes with --yes, else the owner's answer. */
class NotAsked extends Error {}
async function ownerSaysYes(question: string, line: string): Promise<boolean> {
  if (flags.has("--yes")) return true;
  if (!process.stdin.isTTY)
    throw new NotAsked(`Nothing changed. Once you've read the above, run ${line} --yes.`);
  return /^y(es)?$/iu.test((await askInTerminal(`${question} [y/N] `)).trim());
}

switch (command) {
  case "": {
    const web = !flags.has("--no-web");
    // Told from the first moment, as Auni wakes its memory (hello/telling.ts).
    const { startTelling } = await import("./hello/telling.ts");
    const told = startTelling({ web });
    const database = await boot({ runsAuni: true, waiting: told.waiting });
    // Auni's own Postgres is up; an owner's own database is known to answer once migrated.
    if (database) told.memoryReady();
    const { start } = await import("./start.ts");
    await start(database, {
      web,
      open: !flags.has("--no-open"),
      jobs: !flags.has("--no-jobs"),
      told,
    });
    break;
  }
  case "demo": {
    // Nothing of the owner's is read: no boot(), so no ~/.auni/.env, and an environment of the
    // demo's own before anything loads (demo/home.ts).
    const port = Number(flags.get("--port") ?? 3939);
    if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
      console.error("--port takes a port number from 1024 to 65535.");
      process.exitCode = 2;
      break;
    }
    const moment = flags.get("--at");
    const at = typeof moment === "string" ? Date.parse(moment) : undefined;
    if (Number.isNaN(at)) {
      console.error("--at takes a moment, such as 2026-11-11T12:00:00Z.");
      process.exitCode = 2;
      break;
    }
    const { startDemo } = await import("./demo/start.ts");
    await startDemo({
      port,
      web: !flags.has("--no-web"),
      open: !flags.has("--no-open"),
      at,
      firstRun: flags.has("--first-run"),
    });
    break;
  }
  case "pair":
    // For a new device, or to prove the owner is there (auth/proof.ts): for its first 15 minutes
    // the browser that opens the link may allow what takes that proof. With --channel, whoever
    // sends the code to Auni on that channel, in a direct chat, becomes the owner there.
    await withDatabase(async () => {
      const channel = flags.get("--channel");
      if (typeof channel === "string") {
        const { mintChannelPairing } = await import("./channels/hub.ts");
        const pairing = await mintChannelPairing(channel);
        if (!pairing) {
          console.error(`No channel "${channel}" is set up (its token in ~/.auni/.env).`);
          process.exitCode = 1;
        } else
          console.log(
            `Open ${pairing.hint}, or send Auni there: /start ${pairing.code}\n` +
              "(works once, for 15 minutes, from your own account in a direct chat).",
          );
        return;
      }
      const { env } = await import("./env.ts");
      if (env.TAILSCALE_OWNER) {
        // Always on, Tailscale says who the owner is (auth/tailscale.ts): nothing pairs.
        console.log(
          `Auni is at ${env.WEB_ORIGIN}, through Tailscale: open it on any of your devices signed in to your Tailscale account, with nothing to pair. ` +
            "To take a device's access away, remove it from your tailnet in Tailscale.",
        );
        if (flags.has("--sign-out-everywhere")) process.exitCode = 1;
        return;
      }
      const owner = await import("./auth/owner.ts");
      if (flags.has("--sign-out-everywhere")) {
        await owner.signOutEverywhere();
        console.log("Every browser is signed out.");
      }
      const link = owner.pairingLink(await owner.mintPairingCode());
      console.log(
        `Open ${link} to pair this browser as Auni's owner (works once, for 15 minutes).`,
      );
    });
    break;
  case "setup":
    // Never fails on a step that isn't done: that is just the next step. Only a machine it
    // can't read at all (say, its database) exits non-zero.
    await withDatabase(async () => {
      const { env } = await import("./env.ts");
      const { migrateDatabase } = await import("./db/migrations.ts");
      const setup = await import("./setup.ts");
      // As starting Auni would, so a fresh machine's database has its tables to read.
      await migrateDatabase(env.DATABASE_URL);
      const answer = setup.nextStep(await setup.readSetup());
      console.log(flags.has("--json") ? JSON.stringify(answer, null, 2) : setup.said(answer));
    });
    break;
  case "doctor":
    await withDatabase(async () => {
      const { doctorCommand } = await import("./repairs.ts");
      const json = flags.has("--json");
      process.exitCode = await doctorCommand({
        json,
        fix: flags.has("--fix"),
        dryRun: flags.has("--dry-run"),
        // Asked one at a time, starting at yes for a recommended one.
        ask:
          process.stdin.isTTY && !json
            ? async ({ does, recommended }) => {
                const said = (await askInTerminal(`${does}? ${recommended ? "[Y/n]" : "[y/N]"} `))
                  .trim()
                  .toLowerCase();
                return said === "" ? recommended : /^y(es)?$/u.test(said);
              }
            : null,
      });
    });
    break;
  case "triage": {
    // The owner's shell as it was, before boot() reads Auni's settings into this process: the
    // agent's environment is made from it (triage.ts).
    const shell = { ...process.env };
    // Triage helps most when Auni is broken, so a database that won't start is one more finding.
    const database = await boot().catch((error: unknown) => {
      console.error(`Auni's database didn't start: ${(error as Error).message}`);
      return null;
    });
    process.env.DATABASE_URL ||= "postgres://auni-triage-without-a-database";
    const { prepareTriage, startTriage } = await import("./triage.ts");
    console.log("Checking this machine as auni doctor does, then writing what triage reads...");
    let triage;
    try {
      triage = await prepareTriage();
    } finally {
      const { closeDatabaseConnection } = await import("./db/client.ts");
      await closeDatabaseConnection();
      await database?.release();
    }
    const named = flags.get("--brain");
    process.exitCode = await startTriage(triage, {
      shell,
      named: typeof named === "string" ? named : null,
      pick: process.stdin.isTTY && process.stdout.isTTY ? askInTerminal : null,
    });
    break;
  }
  case "build": {
    // The owner's settings, so the build is the one starting Auni would make (web-app.ts).
    readSettings();
    // env.ts insists on these, but a build reads neither: it opens no database and signs nothing.
    process.env.DATABASE_URL ||= "postgres://unused-by-a-build";
    process.env.TURN_TOKEN_SECRET ||= "unused-by-a-build".padEnd(32, ".");
    const { buildWebApp } = await import("./web-app.ts");
    await buildWebApp();
    break;
  }
  case "export":
    await withDatabase(async () => {
      const { env } = await import("./env.ts");
      const { dataDir } = await import("./data-dir.ts");
      const { exportDatabase, ExportRefused } = await import("./db/export.ts");
      const { runningVersion } = await import("./release/layout.ts");
      const { join } = await import("node:path");
      const to = flags.get("--to");
      const stamp = new Date().toISOString().replace(/[-:]|\.\d+/gu, "");
      const file =
        typeof to === "string" ? to : join(dataDir(), "exports", `auni-${stamp}.jsonl.gz`);
      try {
        const { rows, files } = await exportDatabase(env.DATABASE_URL, file, runningVersion());
        console.log(
          `Everything Auni keeps is in ${file}: ${rows} rows and ${files} routine files.\n` +
            "Your wallet's keys and your settings (.env) are not in it: those stay in " +
            `${dataDir()} and the OS keychain.`,
        );
      } catch (error) {
        if (!(error instanceof ExportRefused)) throw error;
        console.error(error.message);
        process.exitCode = 1;
      }
    });
    break;
  case "import":
    await withDatabase(async () => {
      const { env } = await import("./env.ts");
      const { importDatabase, ExportRefused } = await import("./db/export.ts");
      try {
        const { rows, from } = await importDatabase(
          env.DATABASE_URL,
          flags.get("--from") as string,
        );
        console.log(
          `Loaded ${rows} rows from an export of Auni ${from}. Start Auni to bring it up to date.`,
        );
      } catch (error) {
        if (!(error instanceof ExportRefused)) throw error;
        console.error(error.message);
        process.exitCode = 1;
      }
    });
    break;
  case "take-over": {
    // Read once and gone from the environment, so nothing this starts inherits the code.
    const code = process.env.AUNI_HANDOVER_CODE ?? "";
    delete process.env.AUNI_HANDOVER_CODE;
    const shellEnv = { ...process.env };
    const from = flags.get("--from");
    if (typeof from !== "string" || !code) {
      console.error(
        "auni take-over takes the command Settings shows on your laptop, as it is: AUNI_HANDOVER_CODE=... auni take-over --from <address>.",
      );
      process.exitCode = 2;
      break;
    }
    // Loaded once the database is booted, as every module that reads core's settings is: on a
    // machine Auni was only just installed on, they don't exist until then.
    let setUpAlwaysOn: typeof import("./handover/always-on.ts").setUpAlwaysOn | undefined;
    const at = await withDatabase(async () => {
      const alwaysOn = await import("./handover/always-on.ts");
      setUpAlwaysOn = alwaysOn.setUpAlwaysOn;
      const alwaysOnHere = alwaysOn.alwaysOnHere;
      const { env } = await import("./env.ts");
      const { walletApp } = await import("./apps/registry.ts");
      const { takeOver, TakeOverRefused } = await import("./handover/take-over.ts");
      const { about, provided } = walletApp();
      try {
        return await takeOver(
          { from, code, finish: flags.has("--finish") },
          {
            databaseUrl: env.DATABASE_URL,
            wallet: { app: about.id, provided },
            alwaysOnAt: alwaysOnHere,
          },
        );
      } catch (error) {
        if (!(error instanceof TakeOverRefused)) throw error;
        console.error(error.message);
        return null;
      }
    });
    if (!at || !setUpAlwaysOn) {
      process.exitCode = 1;
      break;
    }
    const on = await setUpAlwaysOn(shellEnv, at);
    console.log(
      `\nYour laptop's Auni has stopped for good, and its page sends you to ${at.address}. Its copy stays until you remove it there (auni uninstall). Sign Auni's AI in on this machine from Apps, in the AI's sheet, once you open it.`,
    );
    if (!on) {
      console.error(
        "Nothing of the handover is lost: once that's done, run auni up --always-on here again.",
      );
      process.exitCode = 1;
    }
    break;
  }
  case "stop":
    // Whatever started it: a terminal, the background or the service (running.ts).
    await withDatabase(async () => {
      const { runningAuni, stopAuni, where } = await import("./running.ts");
      const running = await runningAuni();
      if (!running) return void console.log("Auni isn't running.");
      if (!running.here) {
        console.error("Auni runs on this database from another computer: stop it there.");
        process.exitCode = 1;
        return;
      }
      console.log(`Stopping Auni, which runs ${where(running)} (running moves finish first).`);
      if (!(await stopAuni(running))) {
        console.error(
          "Auni is still stopping after two and a half minutes, finishing what it was running. Run auni stop again to wait for it.",
        );
        process.exitCode = 1;
        return;
      }
      console.log(
        running.as === "service"
          ? "Auni is stopped. Its service starts it again when you next log in, or now: auni service install"
          : "Auni is stopped. Start it again with: auni",
      );
    });
    break;
  case "up": {
    const json = flags.has("--json");
    // None asked, it picks one Tailscale serves nothing else on, and says which (always-on.ts).
    const port = flags.has("--port") ? Number(flags.get("--port")) : null;
    if (
      !flags.has("--always-on") ||
      (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535))
    ) {
      console.error(
        flags.has("--always-on")
          ? "--port takes a port number from 1 to 65535."
          : "auni up takes --always-on: Auni on this computer alone is just `auni`.",
      );
      process.exitCode = 2;
      break;
    }
    // At the database, so the Auni running here can be stopped and started again as the service.
    const report = await withDatabase(async () => {
      const { up, thisMachine } = await import("./always-on.ts");
      const { saveAlwaysOn } = await import("./settings.ts");
      const { installService, serviceOutput } = await import("./service.ts");
      const { cameUp, runningAuni, stopAuni } = await import("./running.ts");
      return up(
        port,
        thisMachine(
          {
            save: saveAlwaysOn,
            restartAsService: async () => {
              const running = await runningAuni();
              if (running?.here && !(await stopAuni(running)))
                throw new Error(
                  "Auni is still finishing what it was running after two and a half minutes: run auni up --always-on again to wait for it.",
                );
              // So the service starts Postgres as its own (boot.ts): nothing after this asks the database.
              await letGo();
              console.error(installService());
              if (!(await cameUp()))
                throw new Error(
                  `it didn't come up within 90 seconds: \`${serviceOutput()}\` says why`,
                );
            },
          },
          !json && process.stdin.isTTY,
        ),
      );
    });
    const { upSaid } = await import("./always-on.ts");
    console.log(json ? JSON.stringify(report, null, 2) : upSaid(report));
    process.exitCode = report.ok ? 0 : 1;
    break;
  }
  case "service": {
    const service = await import("./service.ts");
    if (word === "install") console.log(service.installService());
    else service.uninstallService();
    break;
  }
  case "update": {
    // As the owner's shell gave it, before boot() fills in a database for this process alone.
    const shellEnv = { ...process.env };
    const { installed } = await import("./release/layout.ts");
    if (!installed()) {
      console.error("This is a source checkout: update it with git pull, then pnpm install.");
      process.exitCode = 1;
      break;
    }
    const version = flags.get("--version");
    const database = await boot();
    const { env } = await import("./env.ts");
    const { runningAuni, stopAuni, startInBackground } = await import("./running.ts");
    const { postgresRunning, stopPostgres } = await import("./db/embedded.ts");
    const { serviceInstalled, startService } = await import("./service.ts");
    const { update, UpdateRefused } = await import("./release/update.ts");
    try {
      const outcome = await update({
        ...(typeof version === "string" ? { version } : {}),
        host: {
          env: shellEnv,
          running: runningAuni,
          stop: (running) => stopAuni(running),
          start: (as) =>
            as === "service" && serviceInstalled() ? startService() : startInBackground(shellEnv),
          postgres: database && {
            release: () => database.release(),
            hold: () => database.hold(),
            running: postgresRunning,
            stop: stopPostgres,
          },
          export: async (file) => {
            const { exportDatabase } = await import("./db/export.ts");
            const { runningVersion } = await import("./release/layout.ts");
            await exportDatabase(env.DATABASE_URL, file, runningVersion());
          },
          origin: env.WEB_ORIGIN,
          healthyWithinMs: 60_000,
          confirm: (question) => ownerSaysYes(question, "auni update"),
        },
      });
      if (outcome === "rolled-back") process.exitCode = 1;
    } catch (error) {
      if (!(error instanceof UpdateRefused || error instanceof NotAsked)) throw error;
      console.error(error.message);
      process.exitCode = 1;
    } finally {
      const { closeDatabaseConnection } = await import("./db/client.ts");
      await closeDatabaseConnection();
      await database?.release();
    }
    break;
  }
  case "uninstall": {
    const { installed } = await import("./release/layout.ts");
    if (!installed()) {
      console.error("This is a source checkout: delete its folder to remove it.");
      process.exitCode = 1;
      break;
    }
    const { dataDir } = await import("./data-dir.ts");
    // Asked and stopped holding the database, which lets Postgres stop once both let go: it runs
    // from the app being removed. release/uninstall.ts reads the database, so it is imported only
    // once withDatabase has readied what env.ts reads (boot.ts).
    const choice = await withDatabase(async (): Promise<KeysChoice> => {
      const { keysChoice } = await import("./release/uninstall.ts");
      const { runningAuni, stopAuni, where } = await import("./running.ts");
      const running = await runningAuni();
      if (running && !running.here) {
        console.error(
          "Auni runs on this database from another computer: stop it there, then run auni uninstall.",
        );
        return "stop";
      }
      console.log(
        `Uninstalling removes Auni's app, the auni command and its service. Your data stays in ${dataDir()}.`,
      );
      if (running)
        console.log(
          `Auni is running ${where(running)}: uninstalling stops it first, letting running moves finish.`,
        );
      try {
        if (!(await ownerSaysYes("Uninstall Auni?", "auni uninstall"))) {
          console.log("Nothing changed.");
          return "stop";
        }
      } catch (error) {
        if (!(error instanceof NotAsked)) throw error;
        console.error(error.message);
        return "stop";
      }
      // --yes says yes to uninstalling, never to removing the keys: only the owner's sentence does.
      const keys = await keysChoice(process.stdin.isTTY ? askInTerminal : null);
      if (keys === "stop" || !running) return keys;
      console.log("Stopping Auni (running moves finish first).");
      if (await stopAuni(running)) return keys;
      console.error("Auni didn't stop within two and a half minutes, so nothing changed.");
      return "stop";
    });
    if (choice === "stop") process.exitCode = 1;
    else await (await import("./release/uninstall.ts")).uninstall(choice);
    break;
  }
  case "--version": {
    const { runningVersion } = await import("./release/layout.ts");
    console.log(`v${runningVersion()}`);
    break;
  }
}
