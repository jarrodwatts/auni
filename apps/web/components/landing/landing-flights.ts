/**
 * Two of the things that travel from the landing into the conversation: Auni and the question.
 * Each is readied the moment of asking, on the landing alone, and flies once the app's first
 * frame is there to aim at. The box has its own flight, in landing-box.ts.
 */

import {
  CROUCH_MS,
  DIP_EASING,
  LANDING_AT,
  MASCOT_FLIGHT_MS,
  PRESS,
  QUESTION,
  QUESTION_AT,
  center,
  px,
  type Choreography,
} from "./landing-motion";

/** Auni crouches with the dip, gathering itself for the leap. */
export function crouchMascot(hero: HTMLElement | null, { leaving, run }: Choreography) {
  if (!hero) return;
  hero.style.zIndex = "4";
  run(leaving, hero, [{ scale: "1", easing: DIP_EASING }, { scale: "1.05 0.9" }], {
    duration: CROUCH_MS,
    easing: "linear",
  });
}

/**
 * Auni leaps ahead of the camera into its seat: a hop up and over, shrinking as it goes so it
 * stays readable in flight. It touches down softly, squashes, and in that squash becomes the
 * seated Auni, at work on the answer, which springs back up from the same shape.
 */
export function flyMascot(
  hero: HTMLElement | null,
  seat: HTMLElement | null,
  { leaving, arriving, run, at }: Choreography,
) {
  if (!hero || !seat) return;
  const from = hero.getBoundingClientRect();
  const to = seat.getBoundingClientRect();
  const [fx, fy] = center(from);
  const [tx, ty] = center(to);
  const size = to.width / from.width;
  const flight = { delay: at(LANDING_AT), duration: MASCOT_FLIGHT_MS, easing: "linear" };
  run(
    leaving,
    hero,
    [
      { scale: "1.05 0.9", easing: "cubic-bezier(0.2, 0.8, 0.4, 1)" },
      { scale: "0.95 1.05", offset: 0.15, easing: "cubic-bezier(0.5, 0, 0.3, 1)" },
      { scale: `${size}`, offset: 0.88, easing: "ease-out" },
      { scale: `${size * 1.12} ${size * 0.9}` },
    ],
    flight,
  );
  run(
    leaving,
    hero,
    [
      { translate: "0 0", easing: "cubic-bezier(0.45, 0, 0.2, 1)" },
      { translate: `${tx - fx}px 0`, offset: 0.88 },
      { translate: `${tx - fx}px 0` },
    ],
    flight,
  );
  // The hop: up and over, then down onto the seat, arriving at rest. On phones the seat sits
  // above Auni, so a small lift keeps it clear of the header coming down.
  const rise =
    window.innerWidth < 1024 ? Math.min(16, from.height * 0.15) : Math.min(90, from.height * 0.5);
  run(
    leaving,
    hero,
    [
      { translate: "0 0", easing: "cubic-bezier(0.2, 0.6, 0.4, 1)" },
      {
        translate: `0 ${Math.min(0, ty - fy) - rise}px`,
        offset: 0.4,
        easing: "cubic-bezier(0.55, 0, 0.45, 1)",
      },
      { translate: `0 ${ty - fy}px`, offset: 0.88 },
      { translate: `0 ${ty - fy}px` },
    ],
    { ...flight, composite: "add" },
  );
  // At full squash the flying Auni simply becomes the seated one: no fade, no second Auni.
  const touchdown = at(LANDING_AT + MASCOT_FLIGHT_MS);
  run(leaving, hero, [{ opacity: 1 }, { opacity: 0 }], { delay: touchdown, duration: 0 });
  run(
    arriving,
    seat,
    [
      { opacity: 1, scale: "1.12 0.9" },
      { opacity: 1, scale: "1" },
    ],
    { delay: touchdown, duration: PRESS.duration, easing: PRESS.easing },
  );
  run(arriving, seat, [{ opacity: 0 }, { opacity: 1 }], { delay: touchdown, duration: 0 });
}

export interface ReadiedQuestion {
  readonly words: HTMLElement;
  readonly left: number;
  readonly top: number;
  readonly style: CSSStyleDeclaration;
}

/** A copy of the words as typed takes their place on the landing, ready to fly. */
export function readyQuestion(
  input: HTMLTextAreaElement | null,
  page: HTMLElement,
  { added }: Choreography,
): ReadiedQuestion | null {
  if (!input) return null;
  const style = getComputedStyle(input);
  const box = input.getBoundingClientRect();
  const left = box.left + px(style.paddingLeft);
  const top = box.top + px(style.paddingTop);
  const words = document.createElement("div");
  words.setAttribute("aria-hidden", "true");
  words.dir = "auto";
  words.textContent = input.value;
  Object.assign(words.style, {
    position: "fixed",
    zIndex: "4",
    left: `${left}px`,
    top: `${top}px`,
    width: `${input.clientWidth - px(style.paddingLeft) - px(style.paddingRight)}px`,
    margin: "0",
    pointerEvents: "none",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    font: style.font,
    letterSpacing: style.letterSpacing,
    color: style.color,
    transformOrigin: "0 0",
  } satisfies Partial<CSSStyleDeclaration>);
  page.append(words);
  added.push(words);
  input.style.color = "transparent";
  input.style.caretColor = "transparent";
  return { words, left, top, style };
}

/**
 * The asked words travel into the first message. The copy of the words flies with the real
 * bubble on the same path and crossfades into it mid-flight, while both move fast, so a
 * question that wraps differently in the bubble never visibly re-wraps.
 */
export function flyQuestion(
  { words, left, top, style }: ReadiedQuestion,
  bubble: HTMLElement,
  frame: HTMLElement,
  { arriving, run, undo, at }: Choreography,
) {
  const target = bubble.getBoundingClientRect();
  const bubbleStyle = getComputedStyle(bubble);
  const text = bubble.querySelector("p") ?? bubble;
  const scale = px(style.fontSize) / px(getComputedStyle(text).fontSize);
  const padX = px(bubbleStyle.paddingLeft);
  const padY = px(bubbleStyle.paddingTop);
  // Lines are matched on their centres, so the two line heights never offset the words.
  const typedLine = px(style.lineHeight) / 2;
  const bubbleLine = px(getComputedStyle(text).lineHeight) / 2;
  // The bubble starts with its words exactly over the typed words, at the typed size...
  const dx = left - (target.left + padX * scale);
  const dy = top + typedLine - (target.top + (padY + bubbleLine) * scale);
  // ...and the typed words end exactly over the bubble's, at the bubble's size.
  const ex = target.left + padX - left;
  const ey = target.top + padY + bubbleLine - top - typedLine / scale;

  // Nothing in the first frame clips the bubble while it flies in from below and settles.
  for (let node = bubble.parentElement; node && node !== frame; node = node.parentElement) {
    if (getComputedStyle(node).overflow === "visible") continue;
    const overflow = node.style.overflow;
    node.style.overflow = "visible";
    undo.push(() => (node.style.overflow = overflow));
  }

  // The words lift off first and then curve across, so they never slide inside the box.
  const lift = { delay: at(QUESTION_AT), duration: QUESTION.duration, easing: QUESTION.easing };
  const across = { ...lift, delay: at(QUESTION_AT + 50), composite: "add" as const };
  bubble.style.transformOrigin = "0 0";
  undo.push(() => (bubble.style.transformOrigin = ""));
  run(
    arriving,
    bubble,
    [
      { translate: `0 ${dy}px`, scale: `${scale}` },
      { translate: "0 0", scale: "1" },
    ],
    lift,
  );
  run(arriving, bubble, [{ translate: `${dx}px 0` }, { translate: "0 0" }], across);

  // The bubble forms around the words as soon as they are under way.
  run(
    arriving,
    bubble,
    [{ backgroundColor: "transparent" }, { backgroundColor: bubbleStyle.backgroundColor }],
    {
      delay: at(QUESTION_AT + QUESTION.duration * 0.05),
      duration: QUESTION.duration * 0.45,
      easing: "ease",
    },
  );

  // The typed words fly on top of everything (the box's stand-in included) and hand over to
  // the bubble's own words: at rest when both sit on one line, so the swap can't be seen,
  // or mid-flight under a little motion blur when the bubble wraps them differently.
  run(
    arriving,
    words,
    [
      { translate: "0 0", scale: "1" },
      { translate: `0 ${ey}px`, scale: `${1 / scale}` },
    ],
    lift,
  );
  run(arriving, words, [{ translate: "0 0" }, { translate: `${ex}px 0` }], across);
  const oneLine = (element: Element, halfLine: number) =>
    element.getBoundingClientRect().height < halfLine * 3;
  const cross =
    oneLine(words, typedLine) && oneLine(text, bubbleLine)
      ? { delay: at(QUESTION_AT + 50 + QUESTION.duration), duration: 0, easing: "linear" }
      : {
          delay: at(QUESTION_AT + QUESTION.duration * 0.25),
          duration: QUESTION.duration * 0.2,
          easing: "linear",
        };
  run(
    arriving,
    words,
    [
      { opacity: 1, filter: "blur(0)" },
      { opacity: 0, filter: "blur(3px)" },
    ],
    cross,
  );
  run(
    arriving,
    text,
    [
      { opacity: 0, filter: "blur(3px)" },
      { opacity: 1, filter: "blur(0)" },
    ],
    cross,
  );
}
