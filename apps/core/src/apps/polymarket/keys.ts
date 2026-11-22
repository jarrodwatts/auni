import type { FillKey } from "../../money/fill-key.ts";

/** An outcome by its token id; the shares live on Polygon. */
export function outcomeKey(tokenId: string | bigint): FillKey {
  return { chain: "polygon", instrument: String(tokenId) };
}

/** Whether a key names an outcome rather than a token on Polygon: its id is a number. */
export function isOutcome(key: FillKey): boolean {
  return key.chain === "polygon" && /^\d+$/u.test(key.instrument);
}
