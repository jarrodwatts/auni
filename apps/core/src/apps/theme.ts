// A look an app brings: `theme.css` in its folder, which `pnpm gen` copies into the web app's
// styles (scripts/gen-apps.ts) and the owner picks in Settings. A theme is the one way an app
// changes how all of Auni looks, so it may do one thing only: give Auni's own design tokens
// (apps/web/app/tokens.css) other values, under the one selector that is on while it is picked.
// It can't draw, hide or move anything, and it can't load anything from outside. Auni's own two
// looks, light and dark, are the two values each token holds there; an app's look starts from
// the light ones.

/** Every design token the web declares: the custom properties of its tokens.css, by name. */
export function designTokens(tokensCss: string): ReadonlySet<string> {
  return new Set([...tokensCss.matchAll(/^\s*(--[a-z][\w-]*)\s*:/gmu)].map(([, name]) => name!));
}

/** What a theme may give a token: a colour, a length, a font: plain values, nothing fetched. */
const VALUE = /^[\w\s#%.,()/+*"'-]+$/u;

/**
 * Why the app `id`'s `theme.css` can't be one of Auni's looks, or null when it can: it holds
 * one rule, `:root[data-theme="<id>"]`, whose every line sets a token `tokens` holds to a
 * plain value. Comments are allowed anywhere.
 */
export function themeProblem(id: string, css: string, tokens: ReadonlySet<string>): string | null {
  const bare = css.replace(/\/\*[^]*?\*\//gu, "").trim();
  const rule = /^:root\[data-theme="([a-z0-9-]+)"\]\s*\{([^{}]*)\}$/u.exec(bare);
  if (!rule) return `it must be one rule and nothing else: :root[data-theme="${id}"] { … }`;
  if (rule[1] !== id) return `its selector names "${rule[1]}", not "${id}"`;
  const lines = rule[2]!
    .split(";")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return "it sets no token";
  for (const line of lines) {
    const [name = "", ...rest] = line.split(":");
    const value = rest.join(":").trim();
    if (!tokens.has(name.trim()))
      return `"${name.trim()}" isn't one of Auni's design tokens (apps/web/app/tokens.css)`;
    if (!VALUE.test(value) || /url\s*\(|expression\s*\(|\\/iu.test(value))
      return `${name.trim()} may only be a plain value, with nothing fetched: ${value.slice(0, 60)}`;
  }
  return null;
}
