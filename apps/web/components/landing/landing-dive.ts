/**
 * The way in. Sending the first take pushes the camera through the takes ringing it while the
 * words hold still, and the app opens underneath. The sky resolves into the app's white as the
 * sidebar docks under the wordmark, Auni hops into its seat at work on the answer, the take
 * becomes the first message and the box becomes the reply box: the landing's last frame is the
 * app's own.
 *
 * Everything moves as live elements with the Web Animations API, so nothing is snapshotted,
 * stretched or blurred as an image. The landing's side holds its end state until it unmounts;
 * the app's side is cancelled back to its natural style, which is exactly where it came to rest.
 */

import {
  ANSWER_AT,
  COMPOSER,
  DIP_EASING,
  DIP_MS,
  EASE_OUT,
  HEADER_AT,
  LABEL_AT,
  LANDING_AT,
  PARTS,
  PUSH_AT,
  PUSH_EASING,
  PUSH_MS,
  QUESTION,
  QUESTION_AT,
  SHELL_AT,
  center,
  find,
  px,
  shown,
  type Choreography,
} from "./landing-motion";
import { flyComposer, readyComposer, type ReadiedComposer } from "./landing-box";
import {
  crouchMascot,
  flyMascot,
  flyQuestion,
  readyQuestion,
  type ReadiedQuestion,
} from "./landing-flights";

/** However slowly the app opens, the landing gives way by then. */
const ARRIVAL_WATCHDOG_MS = 4_000;
/** However the dive goes once the app is there, it lands by then. */
const LANDING_WATCHDOG_MS = 2_500;

interface LandingDive {
  /** Settles once everything rests in the app, or a watchdog fires. */
  readonly finished: Promise<void>;
  /** Abandons the dive (the landing unmounted early): stops everything and tidies up. */
  readonly cancel: () => void;
}

interface Readied {
  readonly question: ReadiedQuestion | null;
  readonly composer: ReadiedComposer | null;
}

const sleep = (ms: number) => new Promise<null>((resolve) => window.setTimeout(resolve, ms, null));

/**
 * Plays the dive from the landing (`page`) into the conversation's first frame, which the app
 * draws beneath it once its route has opened (`arrived`). Never rejects: a part an engine
 * can't animate is skipped, and the dive still lands.
 */
export function playLandingDive(page: HTMLElement, arrived: Promise<HTMLElement>): LandingDive {
  // Measured on the animations' own clock, so late moves line up with the early ones.
  const now = () => Number(document.timeline.currentTime ?? performance.now());
  const asked = now();
  const act: Choreography = {
    leaving: [],
    arriving: [],
    added: [],
    undo: [],
    at: (ms) => ms,
    run: (list, element, keyframes, options) => {
      if (!element) return;
      try {
        const animation = element.animate(keyframes, { fill: "both", ...options });
        // Two moves on one property (a path's across and its hop) would otherwise let the
        // browser drop the earlier one once both finish, snapping it back.
        animation.persist();
        list.push(animation);
      } catch (error) {
        console.error("[landing dive]", error);
      }
    },
  };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let abandoned = false;

  let readied: Readied = { question: null, composer: null };
  if (!reduced) {
    try {
      readied = ask(page, act);
    } catch (error) {
      console.error("[landing dive]", error);
    }
  }

  const everything = () => [...act.leaving, ...act.arriving];
  // A width change (rotation, window resize) would leave flights aimed at stale spots:
  // jump everything to its end instead.
  let width = window.innerWidth;
  const onResize = () => {
    if (window.innerWidth === width) return;
    width = window.innerWidth;
    for (const animation of everything()) animation.finish();
  };
  window.addEventListener("resize", onResize);
  const tidy = () => {
    window.removeEventListener("resize", onResize);
    for (const element of act.added.splice(0)) element.remove();
    for (const restore of act.undo.splice(0)) restore();
  };

  const finished = (async () => {
    const frame = await Promise.race([arrived, sleep(ARRIVAL_WATCHDOG_MS)]);
    if (abandoned) return;
    // Everything that lands in the app keeps the plan's rhythm from whenever the app opened.
    const late = now() - asked;
    act.at = (ms) => Math.max(0, Math.max(LANDING_AT, late) + ms - LANDING_AT - late);
    try {
      if (frame && !reduced) land(page, frame, readied, act);
      else crossfade(page, act);
    } catch (error) {
      console.error("[landing dive]", error);
    }
    await Promise.race([
      Promise.allSettled(everything().map((animation) => animation.finished)),
      sleep(LANDING_WATCHDOG_MS),
    ]);
    if (abandoned) return;
    for (const animation of act.leaving) {
      try {
        animation.finish();
      } catch {
        // A paused timeline can refuse; the landing unmounts next anyway.
      }
    }
    tidy();
    // The app is now exactly its natural self, with no held animation style left on it.
    for (const animation of act.arriving) animation.cancel();
    await new Promise((resolve) => requestAnimationFrame(resolve));
  })();

  return {
    finished,
    cancel: () => {
      if (abandoned) return;
      abandoned = true;
      for (const animation of act.arriving) animation.cancel();
      tidy();
    },
  };
}

/** Reduced motion, or an app that never opened: the landing simply gives way to what's beneath. */
function crossfade(page: HTMLElement, { leaving, run }: Choreography) {
  run(leaving, page, [{ opacity: 1 }, { opacity: 0 }], { duration: 200, easing: "ease" });
}

/** The moment of asking, on the landing alone: the camera dips and pushes, the rest gathers. */
function ask(page: HTMLElement, act: Choreography): Readied {
  const source = find(page, "source");
  const origin = source
    ? center(source.getBoundingClientRect())
    : ([window.innerWidth / 2, window.innerHeight / 2] as const);
  pushThrough(page, origin, act);
  crouchMascot(find(page, "heroMascot"), act);
  return {
    question: readyQuestion(find<HTMLTextAreaElement>(page, "sourceInput"), page, act),
    composer: readyComposer(source, page, act),
  };
}

/** The app is there: everything settles into it. */
function land(page: HTMLElement, frame: HTMLElement, readied: Readied, act: Choreography) {
  const { leaving, arriving, run, at } = act;
  run(leaving, find(page, "sky"), [{ opacity: 1 }, { opacity: 0 }], {
    delay: at(LANDING_AT),
    duration: 440,
    easing: "ease-in-out",
  });
  arriveShell(page, frame, act);

  run(arriving, find(frame, "answer"), [{ opacity: 0 }, { opacity: 1 }], {
    delay: at(ANSWER_AT),
    duration: 200,
    easing: "ease",
  });
  // Auni leads the way in, shrinking into its seat under where the first words will be.
  flyMascot(find(page, "heroMascot"), find(frame, "seat"), act);

  const bubble = find(frame, "bubble");
  if (readied.question && bubble) flyQuestion(readied.question, bubble, frame, act);
  // Only where the row shows at rest (phones); on wider screens it waits for a hover.
  const meta = find(frame, "meta");
  if (meta && getComputedStyle(meta).opacity === "1")
    run(arriving, meta, [{ opacity: 0 }, { opacity: 1 }], {
      delay: at(QUESTION_AT + QUESTION.duration * 0.6),
      duration: 220,
      easing: "ease",
    });

  const composer = find(frame, "composer");
  if (readied.composer && composer) flyComposer(readied.composer, composer, act);

  // Auni says what it's doing, and what it reads.
  for (const label of frame.querySelectorAll(PARTS.label))
    run(
      arriving,
      label,
      [
        { opacity: 0, translate: "-6px 0", filter: "blur(4px)" },
        { opacity: 1, translate: "0 0", filter: "blur(0)" },
      ],
      { delay: at(LABEL_AT), duration: 300, easing: EASE_OUT },
    );
}

/**
 * The app's frame assembles around the conversation: on wide screens the sidebar docks from
 * the left edge under the wordmark, which settles into the sidebar's own; the place's header
 * comes down into the bar the landing's controls just left.
 */
function arriveShell(page: HTMLElement, frame: HTMLElement, act: Choreography) {
  const { leaving, arriving, run, at } = act;
  const wordmark = find(page, "wordmark");
  const column = frame.closest("main")?.previousElementSibling;
  const sidebar = column instanceof HTMLElement && shown(column) ? column : null;
  const logo = sidebar?.querySelector<HTMLElement>("[role=img][aria-label=Auni]");
  const dock = { delay: at(SHELL_AT), duration: COMPOSER.duration, easing: COMPOSER.easing };

  if (wordmark && logo) {
    const from = wordmark.getBoundingClientRect();
    const to = logo.getBoundingClientRect();
    wordmark.style.transformOrigin = "0 0";
    run(
      leaving,
      wordmark,
      [
        { translate: "0 0", scale: "1" },
        {
          translate: `${to.left - from.left}px ${to.top - from.top}px`,
          scale: `${to.width / from.width}`,
        },
      ],
      dock,
    );
    const docked = at(SHELL_AT + COMPOSER.duration);
    run(leaving, wordmark, [{ opacity: 1 }, { opacity: 0 }], { delay: docked, duration: 0 });
    run(arriving, logo, [{ opacity: 0 }, { opacity: 1 }], { delay: docked, duration: 0 });
  } else {
    run(leaving, wordmark, [{ opacity: 1 }, { opacity: 0 }], {
      delay: at(LANDING_AT),
      duration: 200,
      easing: "ease",
    });
  }
  run(arriving, sidebar, [{ translate: "-100% 0" }, { translate: "0 0" }], dock);

  run(
    arriving,
    find(frame, "header"),
    [
      { opacity: 0, translate: "0 -8px" },
      { opacity: 1, translate: "0 0" },
    ],
    { delay: at(HEADER_AT), duration: 420, easing: EASE_OUT },
  );
}

/**
 * The beliefs are one layer scaled about the question, which moves each belief outward and
 * grows it together, the way things rush past a camera pushing in. Nearer beliefs grow a
 * little more; the copy is a nearer plane still; the grid is far and moves least.
 */
function pushThrough(
  page: HTMLElement,
  [cx, cy]: readonly [number, number],
  { leaving, run }: Choreography,
) {
  const total = PUSH_AT + PUSH_MS;
  const dipped = DIP_MS / total;
  const camera = (element: HTMLElement, depth: number, duration = total) => {
    const box = element.getBoundingClientRect();
    element.style.transformOrigin = `${cx - box.left}px ${cy - box.top}px`;
    run(
      leaving,
      element,
      [
        { scale: "1", easing: DIP_EASING },
        { scale: "0.98", offset: dipped, easing: PUSH_EASING },
        { scale: `${depth}` },
      ],
      { duration, easing: "linear" },
    );
  };
  const push = { delay: PUSH_AT, duration: PUSH_MS, easing: "linear" };

  const thoughts = find(page, "thoughts");
  if (thoughts) {
    camera(thoughts, 3.2);
    run(leaving, thoughts, [{ opacity: 1 }, { opacity: 1, offset: 0.45 }, { opacity: 0 }], push);
    run(
      leaving,
      thoughts,
      [{ filter: "blur(0)" }, { filter: "blur(0)", offset: 0.3 }, { filter: "blur(8px)" }],
      push,
    );
    for (const bubble of thoughts.querySelectorAll<HTMLElement>(PARTS.thought)) {
      const [x, y] = center(bubble.getBoundingClientRect());
      const resting = getComputedStyle(bubble).scale;
      const from = resting === "none" ? 1 : px(resting);
      const distance = Math.hypot(x - cx, y - cy);
      const nearer = 1 + (0.25 * distance) / 600;
      // Beliefs close to the question barely spread under the push, so they clear out to
      // the sides and fade early instead of trailing the box down the screen.
      const close = Math.max(0, 300 - distance) / 300;
      const aside = Math.sign(x - cx || 1) * close * 180;
      run(
        leaving,
        bubble,
        [
          { scale: `${from}`, translate: "0 0" },
          { scale: `${from * nearer}`, translate: `${aside}px 0` },
        ],
        { ...push, easing: PUSH_EASING },
      );
      if (close > 0)
        run(
          leaving,
          bubble,
          [{ opacity: 1 }, { opacity: 1, offset: 0.2 }, { opacity: 0, offset: 0.6 }],
          push,
        );
    }
  }

  for (const node of page.querySelectorAll<HTMLElement>(PARTS.recede)) {
    camera(node, 1.9, total - 60);
    // The nearest plane clears first, so it is gone before the question flies through it.
    run(
      leaving,
      node,
      [
        { opacity: 1, filter: "blur(0)" },
        { opacity: 0, filter: "blur(8px)" },
      ],
      { delay: PUSH_AT, duration: 180, easing: "cubic-bezier(0.2, 0, 0.6, 1)" },
    );
  }

  const grid = find(page, "grid");
  if (grid) {
    grid.style.transformOrigin = `${cx}px ${cy}px`;
    run(
      leaving,
      grid,
      [
        { scale: "1", opacity: 1 },
        { scale: "1.25", opacity: 0, offset: 0.6 },
        { scale: "1.4", opacity: 0 },
      ],
      { ...push, easing: PUSH_EASING },
    );
  }
}
