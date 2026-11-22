/**
 * The sign-in page a CLI's own sign-in printed (Claude Code's "If the browser didn't open, visit:
 * <url>"): the newest web address in what it printed, or null before it has printed one.
 */
export function signInPage(output: string): string | null {
  const pages = output.match(/https:\/\/[^\s]+/gu);
  return pages?.at(-1) ?? null;
}
