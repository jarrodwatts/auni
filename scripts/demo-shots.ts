// Takes a picture of every screen of the demo, so a change to the app can be compared with how
// it looked before:
//
//   pnpm demo:shots [folder] [light|dark]   (default: demo-shots/, which git ignores; both looks)
//
// It starts `auni demo` on a port of its own, signs a headless Chrome in with the link the demo
// prints, and visits the portfolio, the activity list, the apps (the list, a sheet in each
// state the demo's owner has one in, and one Auni itself runs on), a new chat, each pane of
// Settings, every conversation and every specialist the demo's owner has, and first run as a new
// owner meets it (its question, then the first card its take puts up), each at a desktop and a
// phone width, in Auni's light look and then, in a folder `dark` beside them, its dark one.
// A screen longer than the window is taken a window at a time: a conversation from its end back
// to its start, a page from its top down. The demo makes the same owner every time (apps/core/src/demo), and here its clock
// and the browser's both stand at one moment in one time zone, so two runs of one build give the
// same pictures byte for byte, on any day and any machine: a picture differs only where the app
// does.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";

import { launch, type Page } from "./browser.ts";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = resolve(process.argv[2] ?? join(ROOT, "demo-shots"));
/** The looks to take, each as the system's: Auni follows it when the owner has picked none. */
const LOOKS = (["light", "dark"] as const).filter(
  (look) => !process.argv[3] || look === process.argv[3],
);
if (LOOKS.length === 0) throw new Error(`"${process.argv[3]}" is no look: light or dark.`);
/** Its own port, unless `SHOTS_PORT` names another, so two runs on one machine can go side by side. */
const PORT = Number(process.env.SHOTS_PORT ?? 3941);
/** The moment every picture is taken at, and the time zone its dates are read in. */
const AT = "2026-11-11T12:00:00Z";
const TIME_ZONE = "UTC";
const WIDTHS = [
  { name: "desktop", width: 1280, height: 860 },
  { name: "phone", width: 390, height: 844 },
] as const;

/**
 * Starts the demo and resolves with the link that signs a browser in: its seeded owner, or with
 * `--first-run` a new one, before their first take.
 */
function startDemo(...flags: readonly string[]): {
  readonly link: Promise<string>;
  stop(): Promise<void>;
} {
  const demo = spawn(
    process.execPath,
    [
      join(ROOT, "apps/core/bin/auni.mjs"),
      "demo",
      "--no-open",
      "--port",
      String(PORT),
      "--at",
      AT,
      ...flags,
    ],
    // The demo's owner lives in this process's time zone (demo/seed.ts).
    { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, TZ: TIME_ZONE } },
  );
  const link = new Promise<string>((found, failed) => {
    createInterface({ input: demo.stdout }).on("line", (line) => {
      const open = /Open (\S+#pair=\S+)/u.exec(line);
      if (open) found(open[1]!);
    });
    demo.once("exit", (code) => failed(new Error(`The demo stopped (${code}) before it was up.`)));
  });
  return {
    link,
    async stop() {
      demo.kill("SIGTERM");
      await new Promise((stopped) => demo.once("exit", stopped));
    },
  };
}

/** "Buy $250 of Nvidia" as "buy-250-of-nvidia". */
const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .slice(0, 40);

/**
 * Moves the page's main scroller (an open sheet, a conversation's list of messages, or the page
 * itself): to its top or its end when `to` says which, else one window back from that end. Says
 * whether it moved.
 */
const SCROLL = (from: "top" | "end", to?: "top" | "end") => `(() => {
  const sheet = document.querySelector('[data-testid="app-sheet"]');
  const scrollers = (sheet ? [sheet] : [document.scrollingElement, ...document.querySelectorAll("main, main *")]).filter(
    (el) => el && el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY !== "visible",
  );
  const scroller = scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
  if (!scroller) return false;
  const before = scroller.scrollTop;
  if (${JSON.stringify(to ?? null)}) scroller.scrollTop = ${to === "end" ? "scroller.scrollHeight" : "0"};
  else scroller.scrollTop += scroller.clientHeight * 0.85 * ${from === "top" ? 1 : -1};
  return Math.abs(scroller.scrollTop - before) > 5;
})()`;

/**
 * Takes `url` into `out` at each width, a window at a time across all of it: from its top down
 * for a page, from its end back up for a conversation, which opens at its latest message.
 * `first` is what the owner does there before the picture, as script run in the page.
 */
async function take(
  page: Page,
  out: string,
  name: string,
  url: string,
  from: "top" | "end",
  first?: string,
): Promise<void> {
  for (const { name: size, width, height } of WIDTHS) {
    await page.picture(width, height);
    await page.open(url);
    // A blinking caret would make two pictures of one screen differ.
    await page.evaluate(
      `document.head.append(Object.assign(document.createElement("style"), { textContent: "* { caret-color: transparent !important }" }))`,
    );
    // What a page shows of money comes a moment after it loads.
    await sleep(1_200);
    if (first) {
      await page.evaluate(first);
      await sleep(600);
    }
    await page.evaluate(SCROLL(from, from));
    await sleep(300);
    for (let part = 1; part <= 8; part += 1) {
      const file = `${name}.${size}${part === 1 ? "" : `.${part}`}.png`;
      writeFileSync(join(out, file), await page.picture(width, height));
      console.log(file);
      if (!(await page.evaluate<boolean>(SCROLL(from)))) break;
      await sleep(300);
    }
  }
}

/**
 * Every screen, into `out`, as an owner whose system is set to `look` sees it. Each look gets a
 * demo and a browser of its own, since looking changes what a screen shows next (a row that
 * was new, a chat that was unread): both looks picture the same owner at the same moment.
 */
async function shoot(look: (typeof LOOKS)[number], out: string): Promise<void> {
  mkdirSync(out, { recursive: true });
  const browser = await launch();
  const demo = startDemo();
  try {
    const { page } = browser;
    await page.look(look);
    await page.standAt(Date.parse(AT), TIME_ZONE);
    const link = await demo.link;
    const origin = new URL(link).origin;
    await page.open(link);
    // The demo's link lands on a new chat, signed in once the code is off the address.
    await page.until("location.pathname.startsWith('/app') && !location.hash");
    const core = <T>(path: string) =>
      page.evaluate<T>(`fetch("/core/${path}").then((response) => response.json())`);
    const { threads } = await core<{
      threads: { id: string; title: string | null; specialistId: string | null }[];
    }>("threads");

    await take(page, out, "portfolio", `${origin}/app`, "top");
    await take(page, out, "activity", `${origin}/app/activity`, "top");
    await take(page, out, "apps", `${origin}/app/apps`, "top");
    // One sheet for each state an app the owner acts through is in: with money there, needing a
    // key, and what its switch says when pressed (the question, or why it must stay on).
    const { apps } = await core<{
      apps: {
        id: string;
        canSwitch: boolean;
        inUse: boolean;
        jobs: string[];
        needs: string[];
        stays: string | null;
        account: { usd: string | null } | null;
      }[];
    }>("apps");
    const yours = apps.filter((app) => app.canSwitch);
    const holds = (app: (typeof yours)[number]) => Number(app.account?.usd ?? 0) > 0;
    const sheet = (id: string) => `${origin}/app/apps?app=${id}`;
    const SWITCH = `document.querySelector('[data-testid="app-switch"]').click()`;
    const stays = yours.find((app) => holds(app) && app.stays);
    const leaves = yours.find((app) => holds(app) && !app.stays && app.needs.length === 0);
    const needs = yours.find((app) => !app.account && app.needs.length > 0);
    if (stays) {
      await take(page, out, "app-with-money", sheet(stays.id), "top");
      await take(page, out, "app-stays-on", sheet(stays.id), "end", SWITCH);
    }
    if (leaves) await take(page, out, "app-turn-off", sheet(leaves.id), "end", SWITCH);
    if (needs) await take(page, out, "app-needs-a-key", sheet(needs.id), "top");
    // One with money there that still waits for its keys.
    const waits = yours.find((app) => holds(app) && app.needs.length > 0);
    if (waits) await take(page, out, "app-with-money-needs-keys", sheet(waits.id), "top");
    // One Auni itself runs on, the one that does the most jobs: each job as a scene.
    const [runsOn] = apps
      .filter((app) => !app.canSwitch && app.inUse)
      .toSorted((a, b) => b.jobs.length - a.jobs.length);
    if (runsOn) await take(page, out, "app-auni-runs-on", sheet(runsOn.id), "top");
    // A problem the owner reports themselves, as it opens from an app's sheet.
    if (leaves)
      await take(
        page,
        out,
        "report-a-problem",
        `${origin}/app/apps?report=app:${leaves.id}`,
        "top",
      );
    await take(page, out, "new-chat", `${origin}/app/new`, "top");
    // Settings, each of its panes.
    for (const section of ["profile", "wallet", "machine", "help"])
      await take(page, out, `settings-${section}`, `${origin}/app?settings=${section}`, "top");
    for (const thread of threads.toReversed()) {
      const name = slug(thread.title ?? thread.id);
      if (thread.specialistId)
        await take(
          page,
          out,
          `specialist-${name}`,
          `${origin}/app/s/${thread.specialistId}`,
          "end",
        );
      else await take(page, out, `chat-${name}`, `${origin}/app/chat/${thread.id}`, "end");
    }
  } finally {
    await browser.close();
    await demo.stop();
  }
}

/** The demo's take, typed into first run's question and sent as the owner sends it. */
const SEND_TAKE = `(() => {
  const box = document.getElementById("auni-take");
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  set.call(box, "Peptides go mainstream by 2028");
  box.dispatchEvent(new Event("input", { bubbles: true }));
  setTimeout(() => box.form.requestSubmit(), 300);
})()`;

/**
 * First run, as a new owner meets it (`auni demo --first-run`): its question, then the chat its
 * take starts, with the first card its answer puts up.
 */
async function shootFirstRun(look: (typeof LOOKS)[number], out: string): Promise<void> {
  const browser = await launch();
  const demo = startDemo("--first-run");
  try {
    const { page } = browser;
    await page.look(look);
    await page.standAt(Date.parse(AT), TIME_ZONE);
    const link = await demo.link;
    const origin = new URL(link).origin;
    await page.open(link);
    await page.until("location.pathname.startsWith('/app') && !location.hash");
    await take(page, out, "first-run", `${origin}/app/new`, "top");
    await page.evaluate(SEND_TAKE);
    await page.until(
      `location.pathname.startsWith("/app/chat/") && document.body.innerText.includes("to start")`,
      60_000,
    );
    await take(page, out, "first-run-card", await page.evaluate<string>("location.href"), "end");
  } finally {
    await browser.close();
    await demo.stop();
  }
}

rmSync(OUT, { recursive: true, force: true });
for (const look of LOOKS) {
  const out = look === "light" ? OUT : join(OUT, look);
  await shoot(look, out);
  await shootFirstRun(look, out);
}
console.log(`\nThe demo's screens are in ${OUT}`);
