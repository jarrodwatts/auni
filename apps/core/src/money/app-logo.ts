import jpeg from "jpeg-js";
import pngjs from "pngjs";

/**
 * Google's copy of the icon of the site at `address` (a scheme and a host), `size` pixels square
 * where the site has one that big. Without one, Google answers 404 with a stand-in globe.
 */
export function siteIcon(address: string, size: number): string {
  return `https://t1.gstatic.com/faviconV2?client=SOCIAL&type=FAVICON&fallback_opts=TYPE,SIZE,URL&size=${size}&url=${address}`;
}
/** Smaller than this, an icon blurs when a card draws it at 44px on a sharp screen. */
const MIN_SIDE = 96;
const MAX_BYTES = 300_000;
/** A header that claims more pixels than this is never decoded: a tiny file can claim a huge image. */
const MAX_PIXELS = 2_048 * 2_048;
const FETCH_TIMEOUT_MS = 4_000;

export interface AppLogo {
  readonly src: string;
  /** The mark is drawn on transparency, so the card sets it in from the circle's edge. */
  readonly inset: boolean;
}

/**
 * A crisp square logo for an app's site, or null when it has none: a small
 * favicon would only blur, so the card keeps its plain mark instead. A logo
 * is decoration, so any failure is null.
 */
export async function appLogo(host: string): Promise<AppLogo | null> {
  const src = siteIcon(`https://${host}`, 128);
  try {
    const response = await fetch(src, {
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const bytes = await readCapped(response, MAX_BYTES);
    const image = bytes ? decodeImage(bytes) : null;
    if (!image || image.width !== image.height || image.width < MIN_SIDE) return null;
    return { src, inset: clearEdge(image.data, image.width) };
  } catch {
    return null;
  }
}

/** Whether most of a square image's outermost ring of pixels is see-through. */
function clearEdge(rgba: Uint8Array, side: number): boolean {
  let clear = 0;
  for (let i = 0; i < side; i += 1)
    for (const [x, y] of [
      [i, 0],
      [i, side - 1],
      [0, i],
      [side - 1, i],
    ] as const)
      if ((rgba[(y * side + x) * 4 + 3] ?? 0) < 128) clear += 1;
  return clear > side * 2;
}

/** PNG and JPEG by their magic bytes; anything else (SVG, WebP, GIF) is null. */
export function decodeImage(
  bytes: Uint8Array,
): { data: Uint8Array; width: number; height: number } | null {
  try {
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      // IHDR is always first: width and height sit at bytes 16 and 20.
      const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.byteLength < 24 || header.readUInt32BE(16) * header.readUInt32BE(20) > MAX_PIXELS)
        return null;
      const png = pngjs.PNG.sync.read(Buffer.from(bytes));
      return { data: png.data, width: png.width, height: png.height };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      const image = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 64 });
      return { data: image.data, width: image.width, height: image.height };
    }
  } catch {
    // A corrupt image is no logo.
  }
  return null;
}

/** The body, or null once it runs past `limit` bytes: read in chunks, never buffered whole first. */
export async function readCapped(response: Response, limit: number): Promise<Uint8Array | null> {
  if (!response.body) return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    // Leaving the loop cancels the stream; cancelling it here would throw, as the loop holds its lock.
    if (total > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
