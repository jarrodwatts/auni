/**
 * Addresses a person might type, or the agent might write as a link, for a place in the app that
 * lives at another one, each with where it lands. Real use found "/app/portfolio" saying the page
 * doesn't exist: the Portfolio is the app's home, "/app". Each is a redirect in next.config.ts,
 * which keeps any query the address had.
 */
const PLACES: readonly (readonly [string, string])[] = [
  ["/app/portfolio", "/app"],
  ["/app/home", "/app"],
  ["/app/dashboard", "/app"],
  ["/app/team", "/app"],
  ["/app/specialists", "/app"],
  ["/app/s", "/app"],
  ["/app/specialists/:specialist", "/app/s/:specialist"],
  ["/app/specialist/:specialist", "/app/s/:specialist"],
  ["/app/chat", "/app/new"],
  ["/app/chats", "/app/new"],
  ["/app/history", "/app/activity"],
  ["/app/apps/:app", "/app/apps?app=:app"],
  ["/app/settings", "/app?settings=general"],
  ["/app/wallet", "/app?settings=wallet"],
  ["/app/add-money", "/app?fund=open"],
  ["/app/deposit", "/app?fund=open"],
];

/** The app's own places without their "/app", which have no shorter address to stand for. */
const OUTSIDE_APP: readonly (readonly [string, string])[] = [
  ["/chat/:thread", "/app/chat/:thread"],
  ["/activity", "/app/activity"],
  ["/apps", "/app/apps"],
  ["/new", "/app/new"],
];

/** Each of PLACES, the same without its "/app" ("/portfolio", "/settings"), and OUTSIDE_APP. */
export const GUESSED_ADDRESSES = [
  ...PLACES,
  ...PLACES.map(([source, destination]) => [source.slice("/app".length), destination] as const),
  ...OUTSIDE_APP,
].map(([source, destination]) => ({ source, destination }));
