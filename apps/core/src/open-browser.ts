import { spawn } from "node:child_process";
import { platform } from "node:os";

// Opening Auni in this machine's browser, as `auni` does (start.ts).

/**
 * How this `auni` brought the owner's browser to it as it started (openOwner in start.ts):
 * `opened` it, found `no-screen` to open one on, or did `not-open` one (the opener failed, or it
 * was started with --no-open). `auni setup` reads it through /health, so what it tells the owner
 * is what happened rather than a guess; null until this process has tried.
 */
export interface BrowserTry {
  readonly how: "opened" | "no-screen" | "not-opened";
  readonly at: string;
}

let tried: BrowserTry | null = null;

export function browserTried(): BrowserTry | null {
  return tried;
}

export function noteBrowserTry(how: BrowserTry["how"]): void {
  tried = { how, at: new Date().toISOString() };
}

/**
 * Whether a browser can be opened here: not on a server with no screen, or over ssh alone. WSL
 * opens the Windows browser, which needs no screen of Linux's own.
 */
export function canOpenBrowser(): boolean {
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return false;
  const os = platform();
  if (os === "darwin" || os === "win32" || process.env.WSL_DISTRO_NAME) return true;
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

/** Long enough for an opener to hand the link to a browser; one still going is the browser. */
const HANDOFF_MS = 5_000;

/**
 * Opens `url` in this machine's browser without printing it, so a pairing link reaches the
 * browser and nothing else. Resolves once the opener handed it on (xdg-open, open and start each
 * exit 0 then), or is still running after HANDOFF_MS, as an opener that runs the browser itself
 * does. Rejects when there is no opener or it failed: xdg-open exits non-zero on a desktop with
 * no browser to hand it to, which a screen alone (DISPLAY) doesn't promise.
 */
export function openBrowser(url: string): Promise<void> {
  const os = platform();
  const [command, ...args] =
    os === "darwin"
      ? ["open", url]
      : os === "win32"
        ? ["cmd", "/c", "start", "", url]
        : process.env.WSL_DISTRO_NAME
          ? ["cmd.exe", "/c", "start", "", url]
          : ["xdg-open", url];
  return new Promise((resolve, reject) => {
    const opener = spawn(command!, args, { stdio: "ignore", detached: true });
    const running = setTimeout(() => {
      opener.unref();
      resolve();
    }, HANDOFF_MS);
    opener.once("error", (error) => {
      clearTimeout(running);
      reject(error);
    });
    opener.once("exit", (code, signal) => {
      clearTimeout(running);
      if (code === 0) resolve();
      else reject(new Error(`${command} couldn't open a browser (it exited ${code ?? signal})`));
    });
  });
}
