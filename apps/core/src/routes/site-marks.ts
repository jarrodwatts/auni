import { Router } from "express";

import { readCapped, siteIcon } from "../money/app-logo.ts";

/**
 * A site's own mark, as the work shows each site Auni reads (the web's lib/sources.ts): Google's
 * copy of its icon, looked for here by each address Google may know the site by, so the page asks
 * once and gets the mark or nothing, never a missing picture to fall back from.
 */
export const siteMarksRouter = Router();

const FETCH_TIMEOUT_MS = 4_000;
const MAX_BYTES = 100_000;
/** How many sites' answers are kept, found or not, so a site read again isn't looked for again. */
const KEPT = 500;
/** A site as a page names it: dotted labels of letters, digits and hyphens. */
const SITE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const PNG = [0x89, 0x50, 0x4e, 0x47];

/**
 * Where Google may keep a site's icon, best first: the site, then the site it sits under
 * ("ir.williams.com" under "williams.com"), each by https and by http, as Google files some
 * sites under one and not the other.
 */
export function markAddresses(site: string): string[] {
  const labels = site.split(".");
  const hosts = labels.length > 2 ? [site, labels.slice(1).join(".")] : [site];
  return hosts.flatMap((host) => [`https://${host}`, `http://${host}`]);
}

/** The first of the site's addresses Google has an icon for, as PNG bytes, or null for none. */
export async function findSiteMark(
  site: string,
  get: (url: string) => Promise<Response> = (url) =>
    fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
): Promise<Uint8Array | null> {
  for (const address of markAddresses(site)) {
    try {
      const response = await get(siteIcon(address, 64));
      if (!response.ok) continue;
      const bytes = await readCapped(response, MAX_BYTES);
      if (bytes && PNG.every((byte, index) => bytes[index] === byte)) return bytes;
    } catch {
      // A mark is decoration: an address that fails is passed over.
    }
  }
  return null;
}

const found = new Map<string, Promise<Uint8Array | null>>();

siteMarksRouter.get("/:site", async (req, res) => {
  const site = req.params.site.toLowerCase();
  if (!SITE.test(site)) {
    res.status(400).json({ message: "That isn't a site." });
    return;
  }
  let mark = found.get(site);
  if (!mark) {
    mark = findSiteMark(site);
    found.set(site, mark);
    if (found.size > KEPT) found.delete(found.keys().next().value!);
  }
  const bytes = await mark;
  res.set("Cache-Control", "private, max-age=604800");
  // None found is an answer too: the page draws its own plain mark for it.
  if (!bytes) {
    res.status(204).end();
    return;
  }
  res.type("png").send(Buffer.from(bytes));
});
