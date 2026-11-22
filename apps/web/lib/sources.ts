/**
 * The sites a step of the work read: a web search's results, or the page it opened. Each site
 * once, in the order the step gave them, so the work shows where Auni is reading as it reads.
 */

/** As many sites as a step shows beside it. */
const MAX_SITES = 5;

/** A site's mark, its own icon, as core finds it (routes/site-marks.ts), or nothing for none. */
export function siteMark(site: string): string {
  return `/core/site-marks/${encodeURIComponent(site)}`;
}

/** The sites `toolName` read, by its input and what it found: "oanda.com". */
export function stepSites(toolName: string, input: unknown, output: unknown): readonly string[] {
  const urls =
    toolName === "WebSearch"
      ? searchLinks(output)
      : toolName === "WebFetch"
        ? [field(input, "url")]
        : [];
  const sites = urls.flatMap((url) => {
    const site = siteOf(url);
    return site ? [site] : [];
  });
  return [...new Set(sites)].slice(0, MAX_SITES);
}

/** A search's results, as Claude Code lists them: `Links: [{"title": …, "url": …}, …]`. */
function searchLinks(output: unknown): string[] {
  if (typeof output !== "string") return [];
  const listed = /Links: (\[.*?\])(?:\n|$)/su.exec(output)?.[1];
  if (!listed) return [];
  try {
    const links: unknown = JSON.parse(listed);
    return Array.isArray(links) ? links.map((link) => field(link, "url")) : [];
  } catch {
    return [];
  }
}

function field(value: unknown, key: string): string {
  if (!value || typeof value !== "object") return "";
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "string" ? found : "";
}

/** A web address's site, as a person names it: "https://www.cnbc.com/…" is "cnbc.com". */
function siteOf(url: string): string | null {
  try {
    const { hostname, protocol } = new URL(url);
    if (protocol !== "https:" && protocol !== "http:") return null;
    return hostname.replace(/^www\./u, "") || null;
  } catch {
    return null;
  }
}
