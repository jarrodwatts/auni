// Takes a picture of every screen of the demo, so a change to the app can be compared with how
// it looked before:
//
//   pnpm demo:shots [folder] [light|dark]   (default: demo-shots/, which git ignores; both looks)
//
// It starts `auni demo` on a port of its own, signs a headless Chrome in with the link the demo
// prints, and visits Money (a take opened up, a receipt), the apps (the list, a sheet in each
// state the demo's owner has one in, and one Auni itself runs on), a new chat, each pane of
// Settings, every conversation the demo's owner has, and the states between them (the search
// palette, a thread's details pane, Needs you, a phone's Chats and More, a turn's work opened up,
// a message that may not have reached Auni, a page that isn't there, and a browser that isn't
// paired, or brings a link already used), and first run as a new
// owner meets it (each step of its setup), each at a desktop and a phone width, in Auni's light look and then, in a folder `dark` beside them, its dark one.
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
 * Moves the page's main scroller (what's open over the page, such as a sheet or Settings, else a
 * conversation's list of messages, or the page itself): to its top or its end when `to` says
 * which, else one window back from that end. Says whether it moved.
 */
const SCROLL = (from: "top" | "end", to?: "top" | "end") => `(() => {
  const open = [...document.querySelectorAll('[role="dialog"]')].at(-1);
  const scrollers = (open ? [open, ...open.querySelectorAll("*")] : [document.scrollingElement, ...document.querySelectorAll("main, main *")]).filter(
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
 * What the owner does on a screen before its picture, as script run in the page (false when
 * there was nothing to press), and what is true in the page once the state it opens shows.
 */
interface Opener {
  readonly does: string;
  readonly shows: string;
}

/**
 * Takes `url` into `out` at each width, a window at a time across all of it: from its top down
 * for a page, from its end back up for a conversation, which opens at its latest message.
 * `first` opens the state the picture is of; if it can't, the run stops, so no picture of the
 * screen it was opened over is ever saved under that state's name. `only`
 * takes one width, for a state the other doesn't have (a phone's menu), and `once` one window,
 * for something open over the page (the page scrolling under it shows nothing new).
 */
async function take(
  page: Page,
  out: string,
  name: string,
  url: string,
  from: "top" | "end",
  first?: Opener,
  { only, once = false }: { only?: (typeof WIDTHS)[number]["name"]; once?: boolean } = {},
): Promise<void> {
  for (const { name: size, width, height } of WIDTHS.filter((w) => !only || w.name === only)) {
    await page.picture(width, height);
    await page.open(url);
    // A blinking caret would make two pictures of one screen differ.
    await page.evaluate(
      `document.head.append(Object.assign(document.createElement("style"), { textContent: "* { caret-color: transparent !important }" }))`,
    );
    // What a page shows of money comes a moment after it loads.
    await sleep(1_200);
    if (first) {
      const at = `${name} at ${size} width`;
      if ((await page.evaluate<unknown>(first.does)) === false)
        throw new Error(`${at}: nothing on screen opens it (${first.does.trim().slice(0, 80)})`);
      try {
        await page.until(first.shows, 5_000);
      } catch {
        throw new Error(`${at}: it never showed (${first.shows})`);
      }
      await sleep(600);
    }
    await page.evaluate(SCROLL(from, from));
    await sleep(300);
    for (let part = 1; part <= 8; part += 1) {
      const file = `${name}.${size}${part === 1 ? "" : `.${part}`}.png`;
      writeFileSync(join(out, file), await page.picture(width, height));
      console.log(file);
      if (once || !(await page.evaluate<boolean>(SCROLL(from)))) break;
      await sleep(300);
    }
  }
}

/**
 * Presses the first button on screen whose label or words (after any number) start with `label`,
 * and says whether there was one.
 */
const PRESS = (label: string) => `(() => {
  const wanted = ${JSON.stringify(label)};
  const button = [...document.querySelectorAll("button")].find(
    (el) =>
      el.getClientRects().length > 0 &&
      ((el.getAttribute("aria-label") ?? "").startsWith(wanted) ||
        // A step's words follow its number: "2Wallet".
        (el.textContent ?? "").trim().replace(/^\\d+/u, "").trim().startsWith(wanted)),
  );
  button?.click();
  return Boolean(button);
})()`;

/** Opens the receipt of the latest move on Money. */
const OPEN_RECEIPT: Opener = {
  does: `(() => {
  const row = document.querySelector('[aria-label="Recent"] ul button');
  row?.click();
  return row !== null;
})()`,
  shows: `document.querySelector('[role="dialog"]')`,
};

/** Opens the search palette, as its shortcut does. */
const SEARCH: Opener = {
  does: `void window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))`,
  shows: `document.querySelector('[role="dialog"] [role="combobox"]')`,
};

/** Opens the last turn's work that can open: the steps Auni took for its latest answer. */
const OPEN_WORK: Opener = {
  does: `(() => {
  const closed = [...document.querySelectorAll('.auni-steps-line[aria-expanded="false"]')];
  closed.at(-1)?.click();
  return closed.length > 0;
})()`,
  shows: `document.querySelector('.auni-steps-line[aria-expanded="true"]')`,
};

/** A step of first run's wizard, by the words on its button. */
const STEP = (label: string): Opener => ({
  does: PRESS(label),
  shows: `document.querySelector('[aria-current="step"]')?.textContent.includes(${JSON.stringify(label)})`,
});

/**
 * Sends a message core never confirms: the page's own fetch answers the send with a server fault,
 * so the thread shows what it says when a message may not have reached Auni.
 */
const SEND_UNCONFIRMED: Opener = {
  does: `(() => {
  const real = window.fetch;
  window.fetch = (input, init) =>
    init?.method === "POST" && /\\/messages$/u.test(typeof input === "string" ? input : input.url)
      ? Promise.resolve(new Response("{}", { status: 503, headers: { "content-type": "application/json" } }))
      : real(input, init);
  const box = document.querySelector("textarea");
  if (!box) return false;
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "Is now a good time to add more?");
  box.dispatchEvent(new Event("input", { bubbles: true }));
  box.form?.requestSubmit();
  return true;
})()`,
  shows: `document.querySelector('[role="alert"]')`,
};

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
    // A browser that isn't this one: unpaired, and then with the link this one already spent.
    const stranger = await launch();
    try {
      await stranger.page.look(look);
      await stranger.page.standAt(Date.parse(AT), TIME_ZONE);
      await take(stranger.page, out, "pairing-unpaired", `${origin}/app`, "top");
      await take(stranger.page, out, "pairing-link-used", link, "top");
    } finally {
      await stranger.close();
    }
    const core = <T>(path: string) =>
      page.evaluate<T>(`fetch("/core/${path}").then((response) => response.json())`);
    const { threads } = await core<{
      threads: { id: string; title: string | null }[];
    }>("threads");

    await take(page, out, "money", `${origin}/app`, "top");
    // Money with its largest take opened up, and a move's receipt open over it.
    const { takes } = await core<{ takes: { threadId: string; holdings: unknown[] }[] }>("takes");
    if (takes[0])
      await take(page, out, "money-take", `${origin}/app?take=${takes[0].threadId}`, "top");
    // And the largest holding more than one thing, each with what it made.
    const mixed = takes.find(({ holdings }) => holdings.length > 1);
    if (mixed)
      await take(page, out, "money-take-mixed", `${origin}/app?take=${mixed.threadId}`, "top");
    await take(page, out, "money-receipt", `${origin}/app`, "top", OPEN_RECEIPT, { once: true });
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
    const SWITCH: Opener = {
      does: `document.querySelector('[data-testid="app-switch"]').click()`,
      shows: `document.querySelector('[data-testid="app-switch-question"], [data-testid="app-switch-refused"]')`,
    };
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
    for (const section of [
      "general",
      "appearance",
      "personalization",
      "brains",
      "wallet",
      "channels",
      "remote",
      "network",
      "diagnostics",
      "about",
    ])
      await take(page, out, `settings-${section}`, `${origin}/app?settings=${section}`, "top");
    for (const thread of threads.toReversed()) {
      const name = slug(thread.title ?? thread.id);
      await take(page, out, `chat-${name}`, `${origin}/app/chat/${thread.id}`, "end");
    }
    // The states between screens. The take that holds the most is the one to open up.
    const busiest =
      threads.find((thread) => /long bitcoin/iu.test(thread.title ?? "")) ?? threads[0];
    await take(page, out, "search", `${origin}/app`, "top", SEARCH, { once: true });
    await take(page, out, "needs-you", `${origin}/app/needs-you`, "top");
    await take(page, out, "chats", `${origin}/app/chats`, "top", undefined, { only: "phone" });
    const more: Opener = {
      does: PRESS("More"),
      shows: `document.querySelector('[role="dialog"]')`,
    };
    await take(page, out, "phone-more", `${origin}/app`, "top", more, {
      only: "phone",
      once: true,
    });
    await take(page, out, "page-not-found", `${origin}/app/nothing-here`, "top");
    // A message that may not have reached Auni, in a chat no later picture opens.
    const quiet = threads.find((thread) => /nvidia/iu.test(thread.title ?? ""));
    if (quiet)
      await take(
        page,
        out,
        "send-unconfirmed",
        `${origin}/app/chat/${quiet.id}`,
        "end",
        SEND_UNCONFIRMED,
        {
          once: true,
        },
      );
    // A turn's steps opened, in a chat whose answer looked a few things up before it spoke (its
    // chat-... picture shows them folded to one line).
    const looked = threads.find((thread) => /story with sol/iu.test(thread.title ?? ""));
    if (looked)
      await take(page, out, "work-open", `${origin}/app/chat/${looked.id}`, "end", OPEN_WORK);
    if (busiest) {
      const chat = `${origin}/app/chat/${busiest.id}`;
      // Last, as the pane stays open once opened (on this device) for every thread after it.
      const details: Opener = {
        does: PRESS("Show details"),
        shows: `document.querySelector('[aria-label="Hide details"], [role="dialog"]')`,
      };
      await take(page, out, "thread-details", chat, "top", details, {
        once: true,
      });
    }
  } finally {
    await browser.close();
    await demo.stop();
  }
}

/**
 * First run, as a new owner meets it (`auni demo --first-run`): the local setup wizard, each of
 * its steps.
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
    await take(page, out, "first-run-wallet", `${origin}/app/new`, "top", STEP("Wallet"));
    await take(page, out, "first-run-yours", `${origin}/app/new`, "top", STEP("Make it yours"));
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
