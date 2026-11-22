"use client";

import { APP_THEMES, appListing } from "@auni/shared";
import { useEffect, useRef } from "react";

import { useMe } from "@/components/personalization/use-me";
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

/**
 * Keeps this browser's look aligned with the owner's saved look (`me.look`) when updated from
 * another tab, another device, or Auni's `update_auni_preferences` tool in chat.
 */
export function LookSync() {
  const { look: serverLook } = useMe();
  const [localLook, setLook] = useLook();
  const lastServer = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const normalized = serverLook && LOOKS.some(({ id }) => id === serverLook) ? serverLook : null;
    if (lastServer.current === undefined) {
      lastServer.current = normalized;
      // On first mount, apply server preference if set and different from local.
      if (normalized !== null) {
        const target = normalized === "light" ? null : normalized;
        if (target !== localLook) setLook(target);
      }
      return;
    }
    if (normalized === lastServer.current) return;
    lastServer.current = normalized;
    const target = normalized === null || normalized === "light" ? null : normalized;
    if (target !== localLook) setLook(target);
  }, [localLook, serverLook, setLook]);

  return null;
}
