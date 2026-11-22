import { useId } from "react";

/**
 * The owner's account as a vault in Auni's own blues: what holds their money, on the keys only
 * this computer has. Its dial is its own group, so it can turn as the vault arrives.
 */
export function VaultArt({ className }: { readonly className?: string }) {
  const id = useId();
  return (
    <svg aria-hidden viewBox="0 0 32 32" className={className} fill="none">
      <defs>
        <linearGradient
          id={`${id}-body`}
          x1="3"
          y1="2"
          x2="29"
          y2="30"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#5388ff" />
          <stop offset="0.6" stopColor="#98caff" />
          <stop offset="1" stopColor="#bddfff" />
        </linearGradient>
        <radialGradient id={`${id}-warm`} cx="27" cy="27" r="14" gradientUnits="userSpaceOnUse">
          <stop stopColor="#ffe6da" stopOpacity="0.9" />
          <stop offset="1" stopColor="#ffe6da" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="7" y="27" width="5" height="4" rx="2" fill="#354fee" />
      <rect x="20" y="27" width="5" height="4" rx="2" fill="#354fee" />
      <rect x="2" y="2" width="28" height="27" rx="8" fill={`url(#${id}-body)`} />
      <rect x="2" y="2" width="28" height="27" rx="8" fill={`url(#${id}-warm)`} />
      <rect
        x="6"
        y="6"
        width="20"
        height="19"
        rx="5"
        stroke="#ffffff"
        strokeOpacity="0.6"
        strokeWidth="1.3"
      />
      <path
        d="M6.5 4.8c2-1.2 4.6-1.6 7.4-1.6"
        stroke="#ffffff"
        strokeOpacity="0.55"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <g className="auni-vault-dial" style={{ transformOrigin: "15px 15.5px" }}>
        <circle cx="15" cy="15.5" r="5.2" fill="#ffffff" />
        <path
          d="M15 11.3v1.3M15 18.4v1.3M10.8 15.5h1.3M17.9 15.5h1.3"
          stroke="#101e38"
          strokeOpacity="0.55"
          strokeWidth="0.9"
          strokeLinecap="round"
        />
        <circle cx="15" cy="15.5" r="1.7" fill="#354fee" />
        <path d="M15 15.5l2.4-2.4" stroke="#354fee" strokeWidth="1.5" strokeLinecap="round" />
      </g>
      <rect x="22.4" y="12" width="1.8" height="7" rx="0.9" fill="#ffffff" fillOpacity="0.85" />
    </svg>
  );
}
