/** A browser's name from what it says of itself: "Safari on iPhone", "Chrome on Mac". */
export function browserName(agent: string | null): string {
  if (!agent) return "A browser";
  const browser = /edg\//iu.test(agent)
    ? "Edge"
    : /firefox\//iu.test(agent)
      ? "Firefox"
      : /chrome\//iu.test(agent)
        ? "Chrome"
        : /safari\//iu.test(agent)
          ? "Safari"
          : null;
  const device = /iphone/iu.test(agent)
    ? "iPhone"
    : /ipad/iu.test(agent)
      ? "iPad"
      : /android/iu.test(agent)
        ? "Android"
        : /mac os x|macintosh/iu.test(agent)
          ? "Mac"
          : /windows/iu.test(agent)
            ? "Windows"
            : /linux/iu.test(agent)
              ? "Linux"
              : null;
  if (browser && device) return `${browser} on ${device}`;
  return browser ?? (device ? `A browser on ${device}` : "A browser");
}

/** When a browser was last used, as a person says it: "Active now", "Last used 3 hours ago". */
export function lastSeen(at: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (minutes < 2) return "Active now";
  if (minutes < 60) return `Last used ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Last used ${hours === 1 ? "an hour" : `${hours} hours`} ago`;
  const days = Math.floor(hours / 24);
  return `Last used ${days === 1 ? "yesterday" : `${days} days ago`}`;
}
