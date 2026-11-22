/** The timing, springs and part hooks the landing's dive is built from. */

// -- Timing (ms from the moment of asking) ----------------------------------------------

/** The stage pulls back a touch before it lunges. */
export const DIP_MS = 60;
export const PUSH_AT = 60;
export const PUSH_MS = 480;
export const PUSH_EASING = "cubic-bezier(0.3, 0, 0.6, 0.35)";
export const DIP_EASING = "cubic-bezier(0.3, 0, 0.5, 1)";
export const CROUCH_MS = 110;
/**
 * Everything that lands in the app moves from here on. The question, the box and Auni hold
 * still while the camera rushes through the beliefs, which is also the time the app has to
 * open underneath; if it opens later, all of this waits for it together.
 */
export const LANDING_AT = 220;
export const MASCOT_FLIGHT_MS = 480;
export const SHELL_AT = LANDING_AT + 20;
export const COMPOSER_AT = LANDING_AT + 40;
export const QUESTION_AT = LANDING_AT + 80;
export const HEADER_AT = LANDING_AT + 160;
/** What answers the take comes in once its words have flown past it, up to the top of the chat. */
export const ANSWER_AT = LANDING_AT + 300;
export const LABEL_AT = LANDING_AT + 360;

export const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

// -- Springs ------------------------------------------------------------------------------

interface Spring {
  readonly easing: string;
  readonly duration: number;
}

/** Older engines (Safari before 17.2) reject `linear()`; they get a close cubic instead. */
const supportsLinear =
  typeof CSS !== "undefined" && CSS.supports("transition-timing-function", "linear(0, 1)");

/** A damped spring as a CSS `linear()` easing, so moves have weight and a real settle. */
function spring(stiffness: number, damping: number, fallback: string): Spring {
  const w0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * w0);
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  const at = (t: number) =>
    1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  let settle = 0;
  for (let t = 0; t < 3; t += 1 / 240) if (Math.abs(1 - at(t)) > 0.002) settle = t;
  const samples = 48;
  const points = Array.from({ length: samples + 1 }, (_, index) =>
    index === samples ? "1" : at((settle * index) / samples).toFixed(4),
  );
  return {
    easing: supportsLinear ? `linear(${points.join(", ")})` : fallback,
    duration: Math.round(settle * 1000),
  };
}

/** The question: a little overshoot, so it lands rather than stops. */
export const QUESTION = spring(300, 26, "cubic-bezier(0.34, 1.3, 0.64, 1)");
/** The box and the app's panels: near-critical, so nothing wobbles like rubber. */
export const COMPOSER = spring(320, 34, "cubic-bezier(0.22, 1, 0.36, 1)");
/** A button springing back from its press. */
export const PRESS = spring(400, 30, "cubic-bezier(0.34, 1.56, 0.64, 1)");

// -- Parts --------------------------------------------------------------------------------

/**
 * Where each part lives: class hooks owned by the landing (`page`) and by the app's launch
 * stage (`frame`), the first chat's first frame the dive lands in.
 */
export const PARTS = {
  stage: ".auni-belief-stage",
  sky: ".auni-sky",
  thoughts: ".auni-thoughts",
  thought: ".auni-thought-bubble",
  recede: ".auni-belief-title, .auni-belief-subtitle, .auni-belief-cards, .auni-landing-footer",
  wordmark: ".auni-landing-wordmark",
  heroMascot: ".auni-belief-mascot",
  source: ".auni-belief-composer",
  sourceInput: ".auni-belief-composer textarea",
  send: ".auni-belief-send",
  grid: ".auni-sky-grid",
  header: ".auni-conversation-launch-header",
  bubble: ".auni-conversation-launch-message [data-slot=bubble-content]",
  meta: ".auni-conversation-launch-message [data-slot=message-actions]",
  /** The answer to come, or the ask for a brain to think with. */
  answer: ".auni-conversation-launch-thinking",
  /** Auni at work on the answer, or asking for a brain to think with. */
  seat: "[data-take-lands] .auni-mascot-art",
  /** What Auni says it is doing, and what it reads. */
  label: "[data-slot=work-history-trigger], [data-take-lands] [data-reading-site]",
  composer: ".auni-conversation-launch-composer form",
  stop: "button[aria-label='Stop response']",
} as const;
type Part = keyof typeof PARTS;

export function find<T extends Element = HTMLElement>(root: ParentNode, part: Part): T | null {
  const element = root.querySelector<T>(PARTS[part]);
  if (!element && process.env.NODE_ENV !== "production")
    console.warn(`[landing dive] missing ${part}: ${PARTS[part]}`);
  return element;
}

export const shown = (element: Element) => element.getClientRects().length > 0;
export const center = (box: DOMRect) =>
  [box.left + box.width / 2, box.top + box.height / 2] as const;
export const px = (value: string) => parseFloat(value) || 0;

// -- Choreography -------------------------------------------------------------------------

type Run = (
  list: Animation[],
  element: Element | null | undefined,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
) => void;

export interface Choreography {
  /** Animations on the landing: they hold their end state until the landing unmounts. */
  readonly leaving: Animation[];
  /** Animations on the app: cancelled back to natural style once the dive lands. */
  readonly arriving: Animation[];
  readonly run: Run;
  /**
   * The delay for a move planned `ms` after the asking. The app can open later than the
   * plan wanted it; everything that lands in it then keeps its rhythm, just shifted.
   */
  at: (ms: number) => number;
  /** Stand-ins added to the page, removed when the dive ends or is abandoned. */
  readonly added: HTMLElement[];
  /** Temporary style changes to undo when the dive ends or is abandoned. */
  readonly undo: (() => void)[];
}
