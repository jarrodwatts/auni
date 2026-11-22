import { appListing } from "@auni/shared";
import type { CSSProperties } from "react";

import { hasMark, IntegrationMark } from "@/components/integrations/integration-mark";

/** A hue of an app's own, from its id, so one with no logo yet still has a colour that is its. */
function hueOf(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash % 360;
}

/** The first letters of an app's name, two at most: "Elfa" is "E", "Your own key" is "YO". */
function initials(name: string): string {
  const words = name.split(/[\s.-]+/u).filter((word) => /^[\p{L}\p{N}]/u.test(word));
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
}

/**
 * The colour an app is known by, faint enough to sit behind its mark: its logo tile's ring, or
 * for one with no logo, the hue its initials wear.
 */
export function appTint(id: string): string {
  return appListing(id)?.mark?.ring ?? `hsl(${hueOf(id)} 70% 45% / 0.13)`;
}

/**
 * An app's mark at any size: its logo on its own tile, or, for one with no logo, its initials
 * on a tile of the same shape in a colour of its own, so no two read alike.
 */
export function AppMark({
  id,
  name,
  size,
}: {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}) {
  if (hasMark(id)) return <IntegrationMark integration={id} size={size} />;
  const style = {
    "--hue": hueOf(id),
    width: size,
    height: size,
    borderRadius: Math.round(size * 0.3),
    fontSize: Math.round(size * 0.4),
  } as CSSProperties;
  return (
    <span
      aria-hidden
      data-slot="app-mark"
      className="flex shrink-0 items-center justify-center bg-hue-plate leading-none font-semibold tracking-[-0.03em] text-hue-ink inset-ring inset-ring-hue-line"
      style={style}
    >
      {initials(name).slice(0, size < 32 ? 1 : 2) || "?"}
    </span>
  );
}
