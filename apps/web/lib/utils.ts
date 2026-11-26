import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * The scale's own steps in tokens.css, so `cn` knows `text-meta` is a size (which a colour like
 * `text-ink` never overrides), `rounded-card` a corner and `shadow-float` a shadow. tokens.test.ts
 * holds these to the tokens.
 */
export const SCALE = {
  text: [
    "caption",
    "meta",
    "ui",
    "body",
    "reading",
    "section",
    "title",
    "card-money",
    "hero-money",
  ],
  radius: ["control", "card", "sheet"],
  shadow: ["float"],
} as const;

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: [...SCALE.text],
      radius: [...SCALE.radius],
      shadow: [...SCALE.shadow],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
