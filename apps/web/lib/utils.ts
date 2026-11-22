import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/** Knows the type scale in tokens.css, so `text-meta` is a size a color can't override. */
const twMerge = extendTailwindMerge({
  extend: {
    theme: { text: ["caption", "meta", "ui", "reading", "section", "amount", "display", "hero"] },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
