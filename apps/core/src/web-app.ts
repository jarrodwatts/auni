import { type ChildProcess, execFileSync, type IOType, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { getDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { env } from "./env.ts";

// The web app (apps/web), run by `auni` as a child: Next's own server, built first when
// what it's built from has changed since its last build.

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const WEB = join(REPO, "apps/web");
const STAMP = join(WEB, ".next/auni-build");
// The web app exits when Auni does, however Auni ends (a kill -9 too), rather than keep its port
// from the next start: Node closes the IPC channel to a child when its parent dies.
const EXIT_WITH_PARENT = `--import=data:text/javascript,process.on("disconnect",()=>process.exit(0))`;

const next = () => createRequire(join(WEB, "package.json")).resolve("next/dist/bin/next");

/**
 * How the web app's own output reaches this terminal: as it is, or `quiet`, while the terminal's
 * scene plays (hello/telling.ts), with only what goes wrong passed on, through this process's
 * stderr so it waits its turn.
 */
interface WebOutput {
  readonly quiet?: boolean;
  /** Called as a build starts; unset, it is said. */
  readonly onBuild?: () => void;
}

function childOutput(quiet: boolean): IOType[] {
  return quiet ? ["ignore", "ignore", "pipe"] : ["ignore", "inherit", "inherit"];
}

function passOnErrors(child: ChildProcess): void {
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
}

/** Builds the web app if what it's built from changed since its last build (see buildVersion). */
export async function buildWebApp({
  quiet = false,
  onBuild = () => console.log("Building the web app, once for each version of it…"),
}: WebOutput = {}): Promise<void> {
  const childEnv = webEnv();
  const version = buildVersion(childEnv);
  if (version === null || readOr(STAMP) !== version) {
    onBuild();
    // The image optimizer keeps what it served for a month by address, so a picture changed in
    // place (a network's mark) would show as it was: a new build starts with none kept.
    rmSync(join(WEB, ".next/cache/images"), { recursive: true, force: true });
    const build = spawn(process.execPath, [next(), "build"], {
      cwd: WEB,
      env: childEnv,
      stdio: childOutput(quiet),
    });
    passOnErrors(build);
    const [code] = (await once(build, "exit")) as [number | null];
    if (code !== 0) throw new Error(`The web app's build failed (${code}).`);
    if (version !== null) writeFileSync(STAMP, version);
  }
}

/** Whether this version's web app is built already, so starting it builds nothing first. */
export function webAppBuilt(): boolean {
  const version = buildVersion(webEnv());
  return version !== null && readOr(STAMP) === version;
}

/** Builds the web app if it needs it, starts it, and resolves once it reaches core. */
export async function startWebApp(output: WebOutput = {}): Promise<ChildProcess> {
  await buildWebApp(output);
  const childEnv = webEnv();
  const child = spawn(
    process.execPath,
    [
      EXIT_WITH_PARENT,
      // As long to connect to each of a host's addresses as core allows (bin/auni.mjs), for the
      // pictures its optimizer fetches from far-off services.
      `--network-family-autoselection-attempt-timeout=${getDefaultAutoSelectFamilyAttemptTimeout()}`,
      next(),
      "start",
      "-H",
      env.WEB_HOST,
      "-p",
      String(env.WEB_PORT),
    ],
    { cwd: WEB, env: childEnv, stdio: [...childOutput(output.quiet ?? false), "ipc"] },
  );
  passOnErrors(child);
  // Ready once a request through its /core rewrite comes back from core.
  for (let tries = 0; ; tries++) {
    if (child.exitCode !== null) throw new Error(`The web app exited (${child.exitCode}).`);
    const ok = await fetch(`http://${webHost()}:${env.WEB_PORT}/core/health`).then(
      (response) => response.ok,
      () => false,
    );
    if (ok) return child;
    if (tries === 120) {
      child.kill();
      throw new Error("The web app didn't come up within a minute.");
    }
    await sleep(500);
  }
}

/** Where this machine reaches the web app. */
const webHost = () => (env.WEB_HOST === "0.0.0.0" ? "127.0.0.1" : env.WEB_HOST);

/** Headers that belong to one hop, and what Tailscale says of the owner, which the web app never needs. */
const NOT_PASSED = /^(?:connection|keep-alive|proxy-.*|te|trailer|upgrade|tailscale-.*)$/iu;

/**
 * Passes a request the door let in (auth/tailscale.ts) on to the web app, and its answer back.
 * An app that isn't up yet gets a plain 502 that says so.
 */
export function passToWebApp(req: IncomingMessage, res: ServerResponse): void {
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([name]) => !NOT_PASSED.test(name)),
  );
  const onward = request(
    { host: webHost(), port: env.WEB_PORT, method: req.method, path: req.url, headers },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answer.headers);
      answer.pipe(res);
    },
  );
  onward.on("error", () => {
    if (res.headersSent) return void res.destroy();
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end("Auni's web app isn't answering yet. Try again in a minute.");
  });
  req.pipe(onward);
}

/**
 * What the web app is given: where core is, Next's own settings, and the basics a process needs.
 * Core's own secrets stay out of it. Its .env files in apps/web, Next reads itself.
 */
function webEnv(): NodeJS.ProcessEnv {
  const kept = Object.entries(process.env).filter(
    ([key]) => key.startsWith("NEXT_") || ["PATH", "HOME", "TMPDIR", "LANG", "TZ"].includes(key),
  );
  return {
    ...Object.fromEntries(kept),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    // Read as the web app starts (its proxy.ts), so one build serves core on any port.
    CORE_URL: `http://127.0.0.1:${env.PORT}`,
  };
}

/** An app's own card or its schema, which the web app builds (scripts/gen-apps.ts). */
const APP_VIEW = /^apps\/core\/src\/apps\/[^/]+\/[^/]+\.(tsx|schema\.ts)$/u;

/**
 * What a build is of: the web app's and the shared package's committed source, the cards apps
 * draw themselves, its .env files and the settings it's given. Null when that source has changes
 * not yet committed, which build every time. An installed version (a copy of Auni's source, not a
 * clone, whose folder is never edited) builds once, even inside a folder some other git
 * repository holds.
 */
export function buildVersion(childEnv: NodeJS.ProcessEnv, repo = REPO): string | null {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const views = (listed: string) =>
    listed.split("\n").filter((line) => APP_VIEW.test(line.split(/\s/u).at(-1) ?? ""));
  let source: unknown = "unversioned";
  if (existsSync(join(repo, ".git"))) {
    const changed = git("status", "--porcelain", "--", "apps/web", "packages/shared");
    const viewsChanged = views(git("status", "--porcelain", "--", "apps/core/src/apps"));
    if (changed.trim() || viewsChanged.length) return null;
    source = [
      git("rev-parse", "HEAD:apps/web", "HEAD:packages/shared"),
      views(git("ls-tree", "-r", "--full-name", "HEAD", "--", "apps/core/src/apps")),
    ];
  }
  const web = join(repo, "apps/web");
  const envFiles = readdirSync(web)
    .filter((name) => name.startsWith(".env") && name !== ".env.example")
    .sort()
    .map((name) => readOr(join(web, name)));
  const settings = Object.entries(childEnv)
    .filter(([key]) => key.startsWith("NEXT_"))
    .sort();
  return createHash("sha256")
    .update(JSON.stringify([source, envFiles, settings]))
    .digest("hex");
}

function readOr(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
