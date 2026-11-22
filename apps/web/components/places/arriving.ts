"use client";

import { createContext, use } from "react";

/**
 * The app just came in around the owner's first take, in this tab (PlaceShell): the sidebar
 * slides in, and their account (the wallet made for them) drops into its foot.
 */
export const ArrivingContext = createContext(false);

export function useArriving(): boolean {
  return use(ArrivingContext);
}
