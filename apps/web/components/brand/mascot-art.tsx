import "./mascot.css";

import { useId } from "react";

/** The fold over Auni's head, which can swing, and fly off, on its own. */
const FOLD =
  "M121 47C144 38 179 41 198 53C210 60 215 72 211 85C207 102 193 94 181 83C161 66 143 54 121 53Z";

/** A closed eye, curved down like a resting lid. */
const SHUT = ["M102 120q10 8 20 0", "M146 114q10 8 20 0"] as const;

/**
 * Separate facial features let the gaze move without distorting Auni's silhouette. With `joy`,
 * it also has happy eyes, hidden until a celebration shows them in place of the open ones. With
 * `moods`, it carries the other faces Auni pulls (asleep, a wink, a worried brow, dizzy), each
 * hidden until something shows it. With `mouth`, a mouth it opens wide only to gulp something
 * down (money landing on the Portal).
 */
export function MascotArt({
  joy = false,
  moods = false,
  mouth = false,
}: {
  readonly joy?: boolean;
  readonly moods?: boolean;
  readonly mouth?: boolean;
}) {
  const id = useId();
  return (
    <svg aria-hidden viewBox="0 0 256 256" className="auni-mascot-art size-full" fill="none">
      <defs>
        <linearGradient
          id={`${id}-body`}
          x1="57"
          y1="90"
          x2="208"
          y2="191"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#5388ff" />
          <stop offset="0.5" stopColor="#98caff" />
          <stop offset="1" stopColor="#bddfff" />
        </linearGradient>
        <radialGradient
          id={`${id}-warm`}
          cx="0"
          cy="0"
          r="1"
          gradientTransform="translate(207 185) rotate(-139) scale(92 79)"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#ffe6da" />
          <stop offset="0.45" stopColor="#f6dfed" stopOpacity="0.85" />
          <stop offset="1" stopColor="#c8c9ff" stopOpacity="0" />
        </radialGradient>
        <FoldGradient id={`${id}-fold`} />
        <linearGradient
          id={`${id}-crease`}
          x1="164"
          y1="66"
          x2="179"
          y2="88"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#354fee" stopOpacity="0.85" />
          <stop offset="1" stopColor="#5589ff" stopOpacity="0" />
        </linearGradient>
        <path
          id={`${id}-shape`}
          d="M43 145C48 108 77 60 114 46C139 36 176 39 197 53C212 63 209 81 202 94C214 117 226 139 224 162C226 200 199 222 147 225C93 228 58 211 46 182C41 171 40 157 43 145Z"
        />
      </defs>
      <g className="auni-mascot-attention" stroke="#55b5fc" strokeWidth="5" strokeLinecap="round">
        <path d="M54 42L61 54M37 58L48 65M30 78L41 79" />
      </g>
      <use href={`#${id}-shape`} fill={`url(#${id}-body)`} />
      <use href={`#${id}-shape`} fill={`url(#${id}-warm)`} />
      <path
        d="M123 53C155 49 181 68 203 99L191 109C171 89 153 65 123 53Z"
        fill={`url(#${id}-crease)`}
      />
      <path className="auni-mascot-cap" d={FOLD} fill={`url(#${id}-fold)`} />
      <g className="auni-mascot-face">
        <path
          className="auni-mascot-brow"
          d="M90 101C87 92 97 82 106 86C110 87 114 90 116 93C105 91 99 94 90 101Z"
          fill="#101e38"
        />
        <g className="auni-mascot-eyes" fill="#101e38">
          <g className="auni-mascot-eye">
            <ellipse cx="112" cy="121" rx="7.7" ry="12" />
            <ellipse cx="110" cy="116" rx="1.7" ry="2.3" fill="#daedff" opacity="0.65" />
          </g>
          <g className="auni-mascot-eye">
            <ellipse cx="156" cy="115" rx="7.7" ry="12" />
            <ellipse cx="154" cy="110" rx="1.7" ry="2.3" fill="#daedff" opacity="0.65" />
          </g>
        </g>
        {joy ? (
          // Closed in an upward curve.
          <g
            className="auni-mascot-joy"
            stroke="#101e38"
            strokeWidth="9"
            strokeLinecap="round"
            fill="none"
          >
            <path d="M101 126a11 11 0 0 1 22 0" />
            <path d="M145 120a11 11 0 0 1 22 0" />
          </g>
        ) : null}
        {mouth ? (
          <g className="auni-mascot-mouth">
            <ellipse cx="136" cy="152" rx="15" ry="18" fill="#101e38" />
            <ellipse cx="136" cy="162" rx="9" ry="6" fill="#f58ea0" />
          </g>
        ) : null}
        {moods ? (
          <g stroke="#101e38" strokeLinecap="round" fill="none">
            <g className="auni-mascot-mood auni-mascot-shut" strokeWidth="7">
              <path d={SHUT[0]} />
              <path d={SHUT[1]} />
            </g>
            {/* The left eye alone, closed, while the right stays open. */}
            <path className="auni-mascot-mood auni-mascot-wink" d={SHUT[0]} strokeWidth="7" />
            {/* Inner ends raised, the way a worried face's are. */}
            <g className="auni-mascot-mood auni-mascot-worry" strokeWidth="6">
              <path d="M99 101L121 92" />
              <path d="M146 85L168 91" />
            </g>
            <g className="auni-mascot-mood auni-mascot-dizzy" strokeWidth="5">
              <path d="M103 121a9 9 0 1 1 9 9a5.5 5.5 0 1 1-5.5-5.5" />
              <path d="M147 115a9 9 0 1 1 9 9a5.5 5.5 0 1 1-5.5-5.5" />
            </g>
          </g>
        ) : null}
      </g>
    </svg>
  );
}

/** The fold alone, drawn where it sits on Auni, for the moment it flies off. */
export function MascotCap() {
  const id = useId();
  return (
    <svg aria-hidden viewBox="0 0 256 256" className="size-full overflow-visible" fill="none">
      <defs>
        <FoldGradient id={id} />
      </defs>
      <path d={FOLD} fill={`url(#${id})`} />
    </svg>
  );
}

function FoldGradient({ id }: { readonly id: string }) {
  return (
    <linearGradient id={id} x1="141" y1="39" x2="191" y2="99" gradientUnits="userSpaceOnUse">
      <stop stopColor="#88a5ff" />
      <stop offset="0.6" stopColor="#a4aaff" />
      <stop offset="1" stopColor="#6487fa" />
    </linearGradient>
  );
}
