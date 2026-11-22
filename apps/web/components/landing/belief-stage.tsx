"use client";

import { MAXIMUM_MESSAGE_CHARACTERS } from "@auni/shared";
import { ArrowUp, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";

import { useComposerCaret } from "@/components/app/composer-caret";
import {
  InteractiveMascot,
  type InteractiveMascotHandle,
  type MascotReadingTarget,
} from "@/components/brand/interactive-mascot";
import { LogoImage, Monogram } from "@/components/specialist/marks";
import { cn } from "@/lib/utils";
import { REDUCED_MOTION, useMediaQuery } from "@/lib/use-viewport";

interface Pick {
  readonly name: string;
  /** Its mark. */
  readonly logo: string;
}

/** A company's or coin's mark, a file in /public/landing. */
const mark = (file: string): string => `/landing/${file}.svg`;

interface Belief {
  readonly text: string;
  readonly picks: readonly Pick[];
  /** Offset from the centre of Auni's column on wide screens. */
  readonly at: readonly [number, number];
}

/** Takes real people hold, each with companies Auni might pick for it. */
const BELIEFS: readonly Belief[] = [
  {
    text: "Peptides go mainstream",
    picks: [
      { name: "Eli Lilly", logo: mark("eli-lilly") },
      { name: "Novo Nordisk", logo: mark("novo-nordisk") },
      { name: "Hims & Hers", logo: mark("hims-and-hers-health") },
    ],
    at: [-430, -250],
  },
  {
    text: "AI keeps winning",
    picks: [
      { name: "Nvidia", logo: mark("nvidia") },
      { name: "AMD", logo: mark("advanced-micro-devices") },
      { name: "TSMC", logo: mark("taiwan-semiconductor") },
    ],
    at: [415, -268],
  },
  {
    text: "Nuclear makes a comeback",
    picks: [
      { name: "Cameco", logo: mark("cameco") },
      { name: "Constellation", logo: mark("constellation-energy") },
    ],
    at: [-545, -88],
  },
  {
    text: "Tennis is having its moment",
    picks: [
      { name: "On", logo: mark("on-holding") },
      { name: "Nike", logo: mark("nike") },
      { name: "Netflix", logo: mark("netflix") },
    ],
    at: [540, -70],
  },
  {
    text: "Space is the next gold rush",
    picks: [
      { name: "Rocket Lab", logo: mark("rocket-lab") },
      { name: "AST SpaceMobile", logo: mark("ast-spacemobile") },
      { name: "Planet", logo: mark("planet-labs") },
    ],
    at: [-520, 105],
  },
  {
    text: "Crypto goes mainstream",
    picks: [
      { name: "Bitcoin", logo: mark("bitcoin") },
      { name: "Ethereum", logo: mark("ethereum") },
      { name: "Monad", logo: mark("monad") },
    ],
    at: [530, 120],
  },
  {
    text: "Robots are coming",
    picks: [
      { name: "Tesla", logo: mark("tesla") },
      { name: "Intuitive Surgical", logo: mark("intuitive-surgical") },
      { name: "Symbotic", logo: mark("symbotic") },
    ],
    at: [-410, 268],
  },
  {
    text: "Streaming wins the living room",
    picks: [
      { name: "Netflix", logo: mark("netflix") },
      { name: "Spotify", logo: mark("spotify-technology") },
      { name: "Roku", logo: mark("roku") },
    ],
    at: [405, 282],
  },
];

const FEATURE_MS = 3_400;
/** Narrower screens show the takes as cards in two pairs, one above Auni and one below the box. */
const PAIRS = [0, 2, 4, 6].map((start) => BELIEFS.slice(start, start + 2));
/** One row trades its pair for the next this often, the rows taking turns. */
const TURN_MS = 5_000;
const CARD_TILTS = [-3, 2.5, 2, -2.5];
/** A chosen take types itself in within this long, however long it is. */
const TYPE_TOTAL_MS = 280;
const TYPE_STEP_MS = 16;
/** The typed-in take rests this long before it sends. */
const TYPE_HOLD_MS = 120;

/** Where each arrow key moves along the takes: a step either way, or to either end. */
const ARROW_STEPS: Partial<Record<string, number | "first" | "last">> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  Home: "first",
  End: "last",
};

const PRESSED: Keyframe[] = [{ scale: "1" }, { scale: "0.94", offset: 0.3 }, { scale: "1" }];
const PRESS_SPRING = { duration: 360, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" };

type ThoughtStyle = CSSProperties & Record<`--${string}`, string>;

function thoughtStyle({ at }: Belief, index: number): ThoughtStyle {
  return {
    "--thought-x": `${at[0]}px`,
    "--thought-y": `${at[1]}px`,
    "--thought-delay": `${380 + index * 70}ms`,
    "--thought-float": `${6.2 + (index % 3) * 1.3}s`,
    "--thought-phase": `${-index * 1.7}s`,
  };
}

/**
 * The first thing the owner sees: Auni and one question, ringed by takes people hold, each with
 * the companies Auni might put money in for it. Their own take goes in the box; a take tapped
 * types itself in and goes.
 */
export function BeliefStage({
  value,
  onChange,
  under,
  inert = false,
  onSubmit,
}: {
  /** The take as typed so far. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The line under the question. */
  readonly under: ReactNode;
  /** The stage is on its way out: nothing on it takes input any more. */
  readonly inert?: boolean;
  readonly onSubmit: (take: string) => void;
}) {
  const mascotRef = useRef<InteractiveMascotHandle>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typingRef = useRef<number | null>(null);
  const sendingRef = useRef<number | null>(null);
  // Set the moment a take is sent, so a second Enter, click or tap can't send again before the
  // render that marks the stage as leaving.
  const askedRef = useRef(false);
  const [leaving, setLeaving] = useState(false);
  const [featured, setFeatured] = useState(0);
  const [opened, setOpened] = useState<number | null>(null);
  const [peeked, setPeeked] = useState<{ belief: Belief; below: boolean } | null>(null);
  const [turn, setTurn] = useState(0);
  // The takes are one stop for Tab, the arrow keys moving between them, so the keyboard reaches
  // the foot past them in one press.
  const [roving, setRoving] = useState(0);
  const thoughtsRef = useRef<HTMLUListElement>(null);
  // Focus on a take, a card or the peek holds the takes still, so nothing changes under the
  // keyboard; the box's own example is only its placeholder, and typing there stops it anyway.
  const [held, setHeld] = useState(false);
  // Asked for less motion, the takes stay as they are: nothing changes on its own.
  const still = useMediaQuery(REDUCED_MOTION);
  const idle = !value && opened === null && !leaving && !held && !still;

  const trackCaret = useCallback((target: MascotReadingTarget) => {
    mascotRef.current?.trackCaret(target);
  }, []);
  useComposerCaret(inputRef, value, trackCaret);

  // On a phone the keyboard would cover the question; there, a tap opens it.
  useEffect(() => {
    if (!matchMedia("(pointer: coarse)").matches) inputRef.current?.focus();
  }, []);

  // While nobody is typing, one take at a time lights up and fills the question.
  useEffect(() => {
    if (!idle) return undefined;
    const timer = window.setInterval(
      () => setFeatured((index) => (index + 1) % BELIEFS.length),
      FEATURE_MS,
    );
    return () => window.clearInterval(timer);
  }, [idle]);

  // The cards' rows take turns showing the next pair, so every take comes round.
  useEffect(() => {
    if (!idle || peeked) return undefined;
    const timer = window.setInterval(() => setTurn((count) => count + 1), TURN_MS);
    return () => window.clearInterval(timer);
  }, [idle, peeked]);
  const above = PAIRS[(2 * Math.ceil(turn / 2)) % PAIRS.length]!;
  const below = PAIRS[(2 * Math.floor(turn / 2) + 1) % PAIRS.length]!;

  const stopTyping = () => {
    if (typingRef.current !== null) window.clearInterval(typingRef.current);
    if (sendingRef.current !== null) window.clearTimeout(sendingRef.current);
    typingRef.current = null;
    sendingRef.current = null;
  };

  useEffect(() => stopTyping, []);

  const submit = (take: string) => {
    const text = take.trim();
    if (!text || askedRef.current) return;
    askedRef.current = true;
    stopTyping();
    setOpened(null);
    setLeaving(true);
    onSubmit(text);
  };

  // A chosen take types itself into the question, so it's clear what happens next.
  const choose = ({ text: take }: Belief, chip?: HTMLElement) => {
    if (askedRef.current || typingRef.current !== null || sendingRef.current !== null) return;
    setOpened(null);
    // The chosen take answers the tap before it types itself in.
    if (!still) chip?.querySelector(".auni-thought-bubble")?.animate(PRESSED, PRESS_SPRING);
    const perStep = Math.max(1, Math.ceil(take.length / (TYPE_TOTAL_MS / TYPE_STEP_MS)));
    let length = 0;
    typingRef.current = window.setInterval(() => {
      length = Math.min(take.length, length + perStep);
      onChange(take.slice(0, length));
      if (length >= take.length) {
        window.clearInterval(typingRef.current!);
        typingRef.current = null;
        sendingRef.current = window.setTimeout(() => submit(take), TYPE_HOLD_MS);
      }
    }, TYPE_STEP_MS);
  };

  // A take opened is the one the box shows, and where the takes go on from once it closes.
  const open = (index: number) => {
    setOpened(index);
    setFeatured(index);
  };

  const lit = opened ?? (value ? null : featured);

  return (
    <div
      className="auni-belief-stage"
      data-leaving={leaving || undefined}
      inert={inert}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false);
      }}
      onFocus={({ target }: { readonly target: EventTarget }) =>
        setHeld(target !== inputRef.current)
      }
    >
      <div className="auni-belief-column">
        <BeliefCards
          beliefs={above}
          tilts={CARD_TILTS.slice(0, 2)}
          onOpen={(belief) => setPeeked({ belief, below: false })}
        />
        <InteractiveMascot
          ref={mascotRef}
          unfocusable
          size={188}
          className="auni-belief-mascot size-[clamp(64px,12svh,112px)] xl:size-[172px]"
        />
        <h1 className="auni-belief-title">What do you believe?</h1>
        <p aria-live="polite" className="auni-belief-subtitle">
          {under}
        </p>

        <form
          className="auni-belief-composer"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            submit(value);
          }}
        >
          <label className="sr-only" htmlFor="auni-take">
            What do you believe?
          </label>
          <textarea
            ref={inputRef}
            autoComplete="off"
            dir="auto"
            enterKeyHint="send"
            id="auni-take"
            maxLength={MAXIMUM_MESSAGE_CHARACTERS}
            readOnly={leaving}
            rows={1}
            spellCheck={false}
            onChange={(event) => {
              stopTyping();
              onChange(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              submit(value);
            }}
            value={value}
          />
          {value ? null : (
            <>
              <span aria-hidden className="auni-belief-placeholder max-xl:hidden" key={featured}>
                {BELIEFS[featured]!.text}
              </span>
              {/* The cards carry the examples on narrower screens, so the box just invites. */}
              <span aria-hidden className="auni-belief-placeholder xl:hidden">
                Or say it your way
              </span>
            </>
          )}
          <button
            aria-label="Send it to Auni"
            className={cn("auni-belief-send", value.trim() && "is-ready")}
            // Leaving, the stage is inert rather than disabled, so the button keeps its look
            // as it rides into the chat.
            disabled={!value.trim()}
            type="submit"
          >
            <ArrowUp aria-hidden className="size-[18px]" strokeWidth={2.25} />
          </button>
        </form>
        <BeliefCards
          beliefs={below}
          tilts={CARD_TILTS.slice(2)}
          onOpen={(belief) => setPeeked({ belief, below: true })}
        />

        {/* After the question in reading order; drawn around the column wherever it sits. */}
        <ul
          ref={thoughtsRef}
          aria-label="Takes people hold"
          className="auni-thoughts"
          onKeyDown={(event) => {
            const step = ARROW_STEPS[event.key];
            if (step === undefined) return;
            event.preventDefault();
            const next =
              step === "first" ? 0 : step === "last" ? BELIEFS.length - 1 : roving + step;
            const index = (next + BELIEFS.length) % BELIEFS.length;
            setRoving(index);
            thoughtsRef.current?.querySelectorAll("button")[index]?.focus();
          }}
        >
          {BELIEFS.map((belief, index) => (
            <li
              key={belief.text}
              className="auni-thought"
              data-lit={lit === index || undefined}
              data-open={opened === index || undefined}
              data-side={belief.at[0] < 0 ? "left" : "right"}
              style={thoughtStyle(belief, index)}
              // A take opens only to a pointer that moved onto it, never to one the page moved
              // under as it came in.
              onPointerMove={(event) => {
                if (event.pointerType !== "mouse" || opened === index) return;
                if (event.movementX || event.movementY) open(index);
              }}
              onPointerLeave={() => setOpened(null)}
              // The whole take answers the tap, its preview included, so a click that lands
              // as the preview opens under the pointer still counts.
              onClick={(event) => choose(belief, event.currentTarget)}
            >
              <button
                // Enter starts a real chat with it at once, so it says so before it's pressed.
                aria-describedby={`auni-thought-picks-${index}`}
                aria-label={`Start with: ${belief.text}`}
                className="auni-thought-bubble"
                onBlur={() => setOpened(null)}
                onFocus={() => {
                  setRoving(index);
                  open(index);
                }}
                tabIndex={roving === index ? 0 : -1}
                type="button"
              >
                <Logos belief={belief} size={24} className="auni-thought-logos" />
                <span className="auni-thought-text">{belief.text}</span>
              </button>
              <span className="sr-only" id={`auni-thought-picks-${index}`}>
                Auni might pick {belief.picks.map((pick) => pick.name).join(", ")}
              </span>
              <PositionPreview belief={belief} />
            </li>
          ))}
        </ul>
      </div>
      {peeked ? (
        <BeliefPeek
          belief={peeked.belief}
          below={peeked.below}
          onClose={() => setPeeked(null)}
          onStart={() => {
            setPeeked(null);
            choose(peeked.belief);
          }}
        />
      ) : null}
    </div>
  );
}

function Logos({
  belief,
  size,
  className = "auni-belief-card-logos",
}: {
  readonly belief: Belief;
  readonly size: number;
  readonly className?: string;
}) {
  return (
    <span aria-hidden className={className}>
      {belief.picks.map((pick) => (
        <PickMark key={pick.name} pick={pick} size={size} />
      ))}
    </span>
  );
}

/** A pick's picture, or its initials should it not load. */
function PickMark({ pick, size }: { readonly pick: Pick; readonly size: number }) {
  return (
    <LogoImage fallback={<Monogram name={pick.name} size={size} />} size={size} src={pick.logo} />
  );
}

/**
 * Companies Auni might put money in for a take: an example only, since what it picks, and how
 * much in each, is the owner's own AI's to work out.
 */
function Picks({ belief }: { readonly belief: Belief }) {
  return (
    <ul className="auni-thought-card-picks">
      {belief.picks.map((pick) => (
        <li key={pick.name}>
          <PickMark pick={pick} size={22} />
          {pick.name}
        </li>
      ))}
    </ul>
  );
}

/** A row of two takes on narrower screens, each saying what it is; a tap opens it. */
function BeliefCards({
  beliefs,
  tilts,
  onOpen,
}: {
  readonly beliefs: readonly Belief[];
  readonly tilts: readonly number[];
  readonly onOpen: (belief: Belief) => void;
}) {
  return (
    <ul aria-label="Takes people hold" className="auni-belief-cards">
      {beliefs.map((belief, index) => (
        <li key={belief.text} style={{ rotate: `${tilts[index] ?? 0}deg` }}>
          <button
            aria-haspopup="dialog"
            className="auni-belief-card"
            onClick={() => onOpen(belief)}
            type="button"
          >
            <Logos belief={belief} size={22} />
            <span>{belief.text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A tapped card, opened into the position Auni might build; nothing sends until it's started. */
function BeliefPeek({
  belief,
  below,
  onClose,
  onStart,
}: {
  readonly belief: Belief;
  /** Opened from the lower row, so it rises from the bottom edge. */
  readonly below: boolean;
  readonly onClose: () => void;
  readonly onStart: () => void;
}) {
  const startRef = useRef<HTMLButtonElement>(null);
  // Its one action takes focus as it opens, so Enter starts it and Escape closes it.
  useEffect(() => startRef.current?.focus(), []);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div className="auni-belief-peek" data-below={below || undefined} onClick={onClose}>
      <div
        aria-labelledby="belief-peek-title"
        aria-modal="true"
        className="auni-belief-peek-card"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-center justify-between">
          <Logos belief={belief} size={26} />
          <button
            aria-label="Close"
            className="auni-belief-peek-close"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden className="size-3.5" strokeWidth={2.5} />
          </button>
        </div>
        <p className="auni-belief-peek-title" id="belief-peek-title">
          {belief.text}
        </p>
        <p className="auni-thought-card-eyebrow">How Auni might play it</p>
        <Picks belief={belief} />
        <button ref={startRef} className="auni-belief-peek-start" onClick={onStart} type="button">
          Start with this
        </button>
      </div>
    </div>
  );
}

/** What Auni might build for a take, grown from it as it's pointed at: one tap away. */
function PositionPreview({ belief }: { readonly belief: Belief }) {
  return (
    <div aria-hidden className="auni-thought-card">
      <p className="auni-thought-card-eyebrow">How Auni might play it</p>
      <p className="auni-thought-card-title">{belief.text}</p>
      <Picks belief={belief} />
      <p className="auni-thought-card-cta">Start with this</p>
    </div>
  );
}
