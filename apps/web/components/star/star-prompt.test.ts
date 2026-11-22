import type { ReactElement } from "react";
import type { ExternalToast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { toast, core, page } = vi.hoisted(() => ({
  toast: Object.assign(vi.fn<(title: unknown, data: ExternalToast) => void>(), {
    dismiss: vi.fn(),
  }),
  core: {
    starred: false as boolean | null | "unreachable",
    asks: true,
    stars: true as boolean | Promise<boolean>,
    answers: 0,
  },
  page: {
    focused: true,
    activeElement: null as { matches: (selector: string) => boolean } | null,
    events: new EventTarget(),
    fresh: true,
    opened: [] as string[],
    session: new Map<string, string>(),
  },
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/components/brand/mascot", () => ({ Mascot: () => null }));
vi.mock("@/lib/data/me", () => ({
  checkStar: async () => {
    if (core.starred === "unreachable") throw new Error("core is down");
    return core.starred;
  },
  getMe: async () => ({ starPrompt: core.asks ? "ask" : "answered" }),
  starOnGitHub: async () => core.stars,
  answerStarPrompt: async () => void (core.answers += 1),
}));

const IDLE_MS = 30_000;

beforeEach(() => {
  vi.useFakeTimers();
  toast.mockReset();
  toast.dismiss.mockReset();
  Object.assign(core, { starred: false, asks: true, stars: true, answers: 0 });
  Object.assign(page, { focused: true, activeElement: null, events: new EventTarget() });
  Object.assign(page, { fresh: true, opened: [], session: new Map() });
  vi.stubGlobal("document", {
    hasFocus: () => page.focused,
    get activeElement() {
      return page.activeElement;
    },
  });
  vi.stubGlobal("window", {
    addEventListener: page.events.addEventListener.bind(page.events),
    removeEventListener: page.events.removeEventListener.bind(page.events),
    open: (url: string) => void page.opened.push(url),
  });
  vi.stubGlobal("navigator", {
    userActivation: {
      get isActive() {
        return page.fresh;
      },
    },
  });
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => page.session.get(key) ?? null,
    setItem: (key: string, value: string) => page.session.set(key, value),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A page load: the module starts again, and the tab's storage stays. */
async function load() {
  vi.resetModules();
  return (await import("./star-prompt")).askForStarOnce;
}

/** Asks, and leaves the page idle long enough to be asked. */
async function idleAsk() {
  const asked = (await load())();
  await vi.advanceTimersByTimeAsync(IDLE_MS);
  await asked;
}

/** What the toast shows now: its id's latest title and options, merged as Sonner merges them. */
function shown() {
  let now: ExternalToast & { title?: unknown } = {};
  for (const [title, data] of toast.mock.calls) now = { ...now, ...data, title };
  return now;
}
type Actions = ReactElement<{ onStar?: () => void; starring?: boolean; label?: string }>;
const actions = () => shown().action as Actions;

describe("the ask for a star", () => {
  it("asks only once the focused page has been idle", async () => {
    void (await load())();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    page.events.dispatchEvent(new Event("keydown"));
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(toast).not.toHaveBeenCalled();

    page.focused = false;
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(toast).not.toHaveBeenCalled();

    page.focused = true;
    page.activeElement = { matches: (selector) => selector === "iframe" };
    page.events.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(toast).not.toHaveBeenCalled();

    page.activeElement = null;
    page.events.dispatchEvent(new Event("pointerdown"));
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(shown()).toMatchObject({
      id: "star-prompt",
      title: "Enjoying Auni?",
      description: "A star on GitHub helps other people find me.",
      duration: Number.POSITIVE_INFINITY,
    });
  });

  it("asks once a session, a reload of the tab included", async () => {
    await idleAsk();
    await idleAsk();
    expect(toast).toHaveBeenCalledOnce();
    page.session.clear();
    await idleAsk();
    expect(toast).toHaveBeenCalledTimes(2);
  });

  it("never asks once their GitHub account starred Auni, or they answered elsewhere", async () => {
    core.starred = true;
    await idleAsk();
    page.session.clear();
    core.starred = false;
    core.asks = false;
    await idleAsk();
    expect(toast).not.toHaveBeenCalled();
  });

  it("skips a session core can't be reached in, and still asks when gh couldn't say", async () => {
    core.starred = "unreachable";
    await idleAsk();
    expect(toast).not.toHaveBeenCalled();
    page.session.clear();
    core.starred = null;
    await idleAsk();
    expect(toast).toHaveBeenCalledOnce();
  });

  it("takes every close as an answer", async () => {
    await idleAsk();
    shown().onDismiss?.({} as never);
    await vi.advanceTimersByTimeAsync(0);
    expect(core.answers).toBe(1);
  });

  it("stars in place, says Starring meanwhile, and thanks them in the same card", async () => {
    let starred: (value: boolean) => void = () => {};
    core.stars = new Promise((resolve) => (starred = resolve));
    await idleAsk();
    actions().props.onStar?.();
    expect(actions().props.starring).toBe(true);
    starred(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(shown()).toMatchObject({
      id: "star-prompt",
      description: "That helps more people find me.",
      duration: 5_000,
      action: undefined,
    });
    expect(page.opened).toEqual([]);
  });

  it("opens GitHub when it can't star here, or offers to while the tap has gone stale", async () => {
    core.stars = false;
    await idleAsk();
    actions().props.onStar?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(page.opened).toEqual(["https://github.com/jarrodwatts/auni"]);
    expect(toast.dismiss).toHaveBeenCalledWith("star-prompt");

    page.session.clear();
    toast.mockReset();
    page.opened = [];
    page.fresh = false;
    await idleAsk();
    actions().props.onStar?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(page.opened).toEqual([]);
    expect(actions().props.label).toBe("Open GitHub");
    actions().props.onStar?.();
    expect(page.opened).toEqual(["https://github.com/jarrodwatts/auni"]);
  });
});
