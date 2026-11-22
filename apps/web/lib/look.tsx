"use client";

import { APP_THEMES, appListing } from "@auni/shared";
import { useEffect } from "react";

import { useStoredChoice } from "@/components/places/stored-state";

import { LOOK_KEY } from "./look-first";

/**
 * The looks the owner can pick. Auni's own two come first: each is the light or the dark value
 * of every design token (app/tokens.css). After them, one for each app that brings a
 * `theme.css`, which gives those tokens other values (apps/core/src/apps/theme.ts); none ships.
 * With none picked, Auni wears light, whatever the system's look.
 */
export const LOOKS: readonly { readonly id: string; readonly name: string }[] = [
  { id: "light", name: "Light" },
  { id: "dark", name: "Dark" },
  ...APP_THEMES.map((id: string) => ({ id, name: appListing(id)?.name ?? id })),
];

/**
 * The look the owner picked on this device, and how to pick another; null is light.
 * A look whose app has since been removed counts as none.
 */
export function useLook() {
  const [stored, setLook] = useStoredChoice(LOOK_KEY);
  const look = LOOKS.some(({ id }) => id === stored) ? stored : null;
  return [look, setLook] as const;
}

/**
 * Wears the picked look: its id on the document as `data-theme`, which the tokens and each
 * app's theme are written under. Mounted once, over the whole app; the document has already
 * put it on before its first paint (lib/look-first.ts).
 */
export function Look() {
  const [look] = useLook();
  useEffect(() => {
    const root = document.documentElement;
    if (look) root.dataset.theme = look;
    else delete root.dataset.theme;
    // The browser's own bar is told the light page's colour (app/layout.tsx); a picked look
    // tells it the page's colour as now drawn.
    const page = getComputedStyle(root).backgroundColor;
    for (const bar of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      bar.dataset.system ??= bar.content;
      bar.content = look ? page : bar.dataset.system;
    }
  }, [look]);
  return null;
}
