"use client";

import { createContext, useContext } from "react";

/** Closes whichever phone sheet a place link was tapped in. */
export const CloseMobileThreadMenuContext = createContext<() => void>(() => undefined);

/** Closes the phone sheet around the sidebar; a no-op on the desktop rail. */
export function useCloseMobileThreadMenu(): () => void {
  return useContext(CloseMobileThreadMenuContext);
}

/** A phone header's leading control, the menu or the way back: flat, grey hovers, nothing floats. */
export const HEADER_BUTTON_CLASS_NAME =
  "auni-touch-target flex size-8 flex-none items-center justify-center rounded-control text-ink-soft transition-colors duration-200 hover:bg-foreground/[0.05] hover:text-ink lg:hidden";
