/**
 * The box travels from the landing into the conversation as one object: readied the moment of
 * asking, on the landing alone, and flown once the app's reply box is there to aim at.
 */

import {
  COMPOSER,
  COMPOSER_AT,
  DIP_EASING,
  PRESS,
  find,
  type Choreography,
} from "./landing-motion";

export interface ReadiedComposer {
  readonly shell: HTMLElement;
  readonly from: DOMRect;
  readonly style: CSSStyleDeclaration;
  readonly send: HTMLElement | null;
  readonly button: HTMLElement | null;
}

const box = (rect: DOMRect, radius: string): Keyframe => ({
  left: `${rect.left}px`,
  top: `${rect.top}px`,
  width: `${rect.width}px`,
  height: `${rect.height}px`,
  borderRadius: radius,
});

/** Where a button sits in its box, by its right and bottom edges. */
const place = (anchor: DOMRect, element: Element): Keyframe => {
  const rect = element.getBoundingClientRect();
  return {
    right: `${anchor.right - rect.right}px`,
    bottom: `${anchor.bottom - rect.bottom}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
};

/**
 * The box becomes one object for the whole way: a stand-in shell takes the landing pill's
 * place, and answers the Enter like a real press.
 */
export function readyComposer(
  source: HTMLElement | null,
  page: HTMLElement,
  { arriving, run, added }: Choreography,
): ReadiedComposer | null {
  if (!source) return null;
  const from = source.getBoundingClientRect();
  const style = getComputedStyle(source);
  const shell = document.createElement("div");
  shell.setAttribute("aria-hidden", "true");
  Object.assign(shell.style, {
    position: "fixed",
    zIndex: "3",
    pointerEvents: "none",
    background: style.backgroundColor,
    boxShadow: style.boxShadow,
  } satisfies Partial<CSSStyleDeclaration>);
  Object.assign(shell.style, box(from, style.borderTopLeftRadius));
  page.append(shell);
  added.push(shell);
  source.style.visibility = "hidden";

  run(
    arriving,
    shell,
    [
      { scale: "1", easing: DIP_EASING },
      { scale: "0.985", offset: 0.3, easing: PRESS.easing },
      { scale: "1" },
    ],
    { duration: 100 + PRESS.duration, easing: "linear" },
  );

  const send = find(source, "send");
  if (!send) return { shell, from, style, send, button: null };
  const button = send.cloneNode(true) as HTMLElement;
  Object.assign(button.style, {
    position: "absolute",
    margin: "0",
    transition: "none",
  } satisfies Partial<CSSStyleDeclaration>);
  Object.assign(button.style, place(from, send));
  shell.append(button);
  run(
    arriving,
    button,
    [
      { transform: getComputedStyle(send).transform, easing: "ease-out" },
      { transform: "scale(0.9)", offset: 70 / (70 + PRESS.duration), easing: PRESS.easing },
      { transform: "none" },
    ],
    { duration: 70 + PRESS.duration, easing: "linear" },
  );
  return { shell, from, style, send, button };
}

/**
 * The shell rides from the landing's pill to the reply box. Its send button stays solid,
 * resizes into the stop button and turns its arrow into a square on the way. The real composer
 * fades in under the shell as they come together, so the reply box is never an empty white
 * box; the shell then melts away.
 */
export function flyComposer(
  { shell, from, style, send, button }: ReadiedComposer,
  target: HTMLElement,
  { arriving, run, at }: Choreography,
) {
  const to = target.getBoundingClientRect();
  const targetStyle = getComputedStyle(target);
  const flight = { delay: at(COMPOSER_AT), duration: COMPOSER.duration, easing: COMPOSER.easing };
  run(
    arriving,
    shell,
    [box(from, style.borderTopLeftRadius), box(to, targetStyle.borderTopLeftRadius)],
    flight,
  );
  // From the pill's lifted shadow to the reply box's own.
  run(
    arriving,
    shell,
    [{ boxShadow: style.boxShadow }, { boxShadow: targetStyle.boxShadow }],
    flight,
  );

  const stop = find(target, "stop");
  if (send && button && stop) {
    // Stop's visible disc sits inside a larger touch target; the flight aims at the disc.
    const disc = stop.querySelector("span") ?? stop;
    run(arriving, button, [place(from, send), place(to, disc)], flight);

    const arrow = button.querySelector<SVGElement>("svg");
    const square = stop.querySelector("svg")?.cloneNode(true) as SVGElement | undefined;
    const morphAt = COMPOSER_AT + COMPOSER.duration * 0.55;
    if (arrow) arrow.style.gridArea = "1 / 1";
    run(
      arriving,
      arrow,
      [
        { opacity: 1, scale: "1" },
        { opacity: 0, scale: "0.4" },
      ],
      { delay: at(morphAt), duration: 120, easing: "ease-in" },
    );
    if (square) {
      square.style.gridArea = "1 / 1";
      button.append(square);
      run(
        arriving,
        square,
        [
          { opacity: 0, scale: "0.4" },
          { opacity: 1, scale: "1" },
        ],
        { delay: at(morphAt + 50), duration: PRESS.duration, easing: PRESS.easing },
      );
    }
  }

  const handover = COMPOSER_AT + COMPOSER.duration * 0.7;
  run(arriving, target, [{ opacity: 0 }, { opacity: 1 }], { delay: at(handover), duration: 120 });
  run(arriving, shell, [{ opacity: 1 }, { opacity: 0 }], {
    delay: at(handover + 120),
    duration: 120,
    easing: "ease",
  });
}
