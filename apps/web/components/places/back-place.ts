import { CHATS_HREF, NEEDS_YOU_HREF } from "@/lib/app-links";

/** Where a phone's back arrow in a chat leads, and what it's called. */
export interface BackPlace {
  readonly href: string;
  readonly label: string;
}

const TO_CHATS: BackPlace = { href: CHATS_HREF, label: "Back to chats" };
const TO_NEEDS_YOU: BackPlace = { href: NEEDS_YOU_HREF, label: "Back to Needs you" };

/**
 * Back from a chat goes to the list it was opened from: Needs you when the owner is working
 * through what waits on them, so each card done leads to the next; Chats from anywhere else.
 */
export function backFrom(openedFrom: string | null): BackPlace {
  return openedFrom === NEEDS_YOU_HREF ? TO_NEEDS_YOU : TO_CHATS;
}

/** The place the last chat was opened from, for as long as this tab is open. */
let openedFrom: string | null = null;

/** Notes where a chat is being opened from, as its link is tapped. */
export function noteOpenedFrom(pathname: string): void {
  openedFrom = pathname;
}

/** Where the open chat's back arrow leads. */
export function backPlace(): BackPlace {
  return backFrom(openedFrom);
}
