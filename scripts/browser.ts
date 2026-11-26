// A headless Chrome, driven over its DevTools protocol with nothing but Node: enough to open a
// page, wait until it has settled, and take its picture at a given width. `scripts/demo-shots.ts`
// uses it to capture every screen of the demo.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

/** A Chrome or Chromium on this machine: CHROME_PATH, one on the PATH, or one Playwright fetched. */
function chromePath(): string {
  const named = process.env.CHROME_PATH;
  if (named) return named;
  const onPath = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
    .flatMap((name) => (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, name)))
    .find(existsSync);
  if (onPath) return onPath;
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(mac)) return mac;
  const fetched = join(homedir(), ".cache/ms-playwright");
  const shell = existsSync(fetched)
    ? readdirSync(fetched)
        .filter((name) => name.startsWith("chromium_headless_shell-"))
        .sort()
        .map((name) => join(fetched, name, "chrome-headless-shell-linux64/chrome-headless-shell"))
        .findLast(existsSync)
    : undefined;
  if (shell) return shell;
  throw new Error("No Chrome found: install Chrome or Chromium, or set CHROME_PATH to one.");
}

/** One tab of the browser. */
export interface Page {
  /** Opens `url` and waits until the page has loaded and gone quiet. */
  open(url: string): Promise<void>;
  /** Runs `expression` in the page and returns what it evaluates to (a promise is awaited). */
  evaluate<T>(expression: string): Promise<T>;
  /** Waits until `expression` is truthy in the page, or throws after `timeoutMs`. */
  until(expression: string, timeoutMs?: number): Promise<void>;
  /** Waits until nothing has loaded for a moment: the page has what it asked for. */
  settled(): Promise<void>;
  /** Has the page see the system as set to `look`, which Auni follows unless the owner picked one. */
  look(look: "light" | "dark"): Promise<void>;
  /** Has every page opened from here on tell the time as `at`, in `timeZone`, and never later. */
  standAt(at: number, timeZone: string): Promise<void>;
  /** The page as a PNG at `width` by `height` CSS pixels, drawn at twice that for sharpness. */
  picture(width: number, height: number): Promise<Buffer>;
}

export interface Browser {
  readonly page: Page;
  close(): Promise<void>;
}

/**
 * Starts a headless Chrome and gives its one tab. Its profile is a folder of its own, removed as
 * it closes, unless `keptProfile` names one to keep, so a sign-in carries over to the next run.
 */
export async function launch(keptProfile?: string, signal?: AbortSignal): Promise<Browser> {
  const executable = chromePath();
  signal?.throwIfAborted();
  // Chromium adds its own directory and SingletonSocket under TMPDIR. Use a short,
  // private path so even a long caller TMPDIR leaves room for that Unix socket.
  const scratch = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "a-"));
  const profile = keptProfile ?? join(scratch, "p");
  const chrome = spawn(
    executable,
    [
      "--headless=new",
      "--no-sandbox",
      "--hide-scrollbars",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
      // Chrome can create other scratch folders besides its profile.
      env: { ...process.env, TMPDIR: scratch, TEMP: scratch, TMP: scratch },
      signal,
      // On cancellation Chrome may be stuck serving a request. Its profile is disposable.
      killSignal: "SIGKILL",
    },
  );
  const remove = () => rmSync(scratch, { recursive: true, force: true });
  const onExit = () => {
    chrome.kill("SIGKILL");
    remove();
  };
  process.once("exit", onExit);
  const exited = new Promise<void>((resolve) => {
    chrome.once("exit", () => resolve());
    // A failed spawn emits close without exit.
    chrome.once("close", () => resolve());
  });
  const close = async () => {
    chrome.kill();
    const force = setTimeout(() => chrome.kill("SIGKILL"), 2_000);
    try {
      await exited;
    } finally {
      clearTimeout(force);
      chrome.stderr.destroy();
      remove();
      process.off("exit", onExit);
    }
  };

  try {
    // Chrome says where its DevTools listens on its first lines.
    const endpoint = await new Promise<string>((resolve, reject) => {
      createInterface({ input: chrome.stderr }).on("line", (line) => {
        const found = /DevTools listening on (ws:\/\/\S+)/u.exec(line);
        if (found) resolve(found[1]!);
      });
      chrome.on("error", reject);
      chrome.once("exit", (code, signal) =>
        reject(new Error(`Chrome stopped (${code ?? signal}) before it was ready.`)),
      );
    });
    const socket = new WebSocket(endpoint);
    try {
      await new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      const page = await openPage(socket, signal);
      return {
        page,
        async close() {
          socket.close();
          await close();
        },
      };
    } catch (error) {
      socket.close();
      throw error;
    }
  } catch (error) {
    await close();
    throw error;
  }
}

async function openPage(socket: WebSocket, signal?: AbortSignal): Promise<Page> {
  let sent = 0;
  const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  socket.addEventListener("close", () => {
    for (const { reject } of waiting.values()) reject(new Error("Chrome disconnected."));
    waiting.clear();
  });
  // Requests still in flight, and when the last one started or ended: how `settled` knows.
  const loading = new Set<string>();
  let lastLoad = Date.now();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(String(data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: { requestId?: string; type?: string };
    };
    if (message.id !== undefined) {
      const asked = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) asked?.reject(new Error(message.error.message));
      else asked?.resolve(message.result);
      return;
    }
    const request = message.params?.requestId;
    if (!request) return;
    // A stream the page keeps open (its live updates) never ends, so it never counts.
    if (message.method === "Network.requestWillBeSent" && message.params?.type !== "EventSource") {
      loading.add(request);
      lastLoad = Date.now();
    }
    if (
      message.method === "Network.loadingFinished" ||
      message.method === "Network.loadingFailed"
    ) {
      loading.delete(request);
      lastLoad = Date.now();
    }
  });
  // The tab's session, once attached: until then a call is the browser's own.
  const attached: { session?: string } = {};
  const send = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      signal?.throwIfAborted();
      if (socket.readyState !== WebSocket.OPEN) throw new Error("Chrome disconnected.");
      const id = ++sent;
      waiting.set(id, { resolve: resolve as (value: unknown) => void, reject });
      socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(attached.session ? { sessionId: attached.session } : {}),
        }),
      );
    });

  const { targetInfos } = await send<{ targetInfos: { targetId: string; type: string }[] }>(
    "Target.getTargets",
  );
  const tab = targetInfos.find(({ type }) => type === "page")!;
  attached.session = (
    await send<{ sessionId: string }>("Target.attachToTarget", {
      targetId: tab.targetId,
      flatten: true,
    })
  ).sessionId;
  await send("Page.enable");
  const see = (look: "light" | "dark") =>
    send("Emulation.setEmulatedMedia", {
      features: [
        // Nothing moves, so two pictures of one screen are the same picture.
        { name: "prefers-reduced-motion", value: "reduce" },
        { name: "prefers-color-scheme", value: look },
      ],
    });
  await see("light");
  await send("Network.enable");
  await send("Runtime.enable");

  const page: Page = {
    async open(url) {
      loading.clear();
      await send("Page.navigate", { url });
      await page.until("document.readyState === 'complete'");
      await page.settled();
    },
    async evaluate<T>(expression: string) {
      const { result, exceptionDetails } = await send<{
        result: { value: T };
        exceptionDetails?: { text: string; exception?: { description?: string } };
      }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (exceptionDetails)
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    },
    async until(expression, timeoutMs = 30_000) {
      const deadline = Date.now() + timeoutMs;
      while (!(await page.evaluate<boolean>(`Boolean(${expression})`).catch(() => false))) {
        signal?.throwIfAborted();
        if (Date.now() > deadline) throw new Error(`The page never reached: ${expression}`);
        await sleep(100);
      }
    },
    async settled() {
      const deadline = Date.now() + 20_000;
      // Quiet for a moment, and the fonts in: what is drawn now is what stays.
      while (Date.now() < deadline && (loading.size > 0 || Date.now() - lastLoad < 700))
        await sleep(100, undefined, { signal });
      await page.evaluate("document.fonts.ready.then(() => true)");
    },
    async look(look) {
      await see(look);
      // Auni wears light unless the owner picks another look (lib/look.tsx), whatever the
      // system's, so the dark pictures pick it as the owner would, before the page's first paint.
      await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `try{localStorage.setItem("auni:look",${JSON.stringify(look === "dark" ? "dark" : "")});if(${JSON.stringify(look)}!=="dark")localStorage.removeItem("auni:look")}catch(e){}`,
      });
    },
    async standAt(at, timeZone) {
      await send("Emulation.setTimezoneOverride", { timezoneId: timeZone });
      // `Date` asked the time (`Date.now()`, `new Date()`) says `at`; given a time, it is itself.
      await send("Page.addScriptToEvaluateOnNewDocument", {
        source: `globalThis.Date = new Proxy(Date, {
          construct: (target, args, newTarget) =>
            Reflect.construct(target, args.length === 0 ? [${at}] : args, newTarget),
          get: (target, key, receiver) =>
            key === "now" ? () => ${at} : Reflect.get(target, key, receiver),
        });`,
      });
    },
    async picture(width, height) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 2,
        mobile: width < 600,
      });
      // A resize lays the page out again, and some of it loads more.
      await sleep(300);
      await page.settled();
      const { data } = await send<{ data: string }>("Page.captureScreenshot", { format: "png" });
      return Buffer.from(data, "base64");
    },
  };

  return page;
}
