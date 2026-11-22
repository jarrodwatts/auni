import Image from "next/image";

/** The lockup's own shape: both of its pictures are 1309 by 429. */
const ASPECT = 1309 / 429;

/**
 * Auni's lockup, the mascot beside the word "auni", at `height` pixels tall. It is two layers of
 * one size: the mascot as a picture, and the word as a shape filled with ink, so the word reads
 * in every look.
 */
export function Lockup({
  height,
  priority,
}: {
  readonly height: number;
  readonly priority?: boolean;
}) {
  const width = Math.round(height * ASPECT);
  return (
    <span
      role="img"
      aria-label="Auni"
      className="relative block flex-none"
      style={{ width, height }}
    >
      <Image
        src="/brand/auni-lockup-mascot.png"
        alt=""
        className="block size-full"
        width={width}
        height={height}
        priority={priority}
      />
      <span
        aria-hidden
        className="absolute inset-0 bg-ink"
        style={{ mask: "url(/brand/auni-lockup-word.png) 0 0 / 100% 100% no-repeat" }}
      />
    </span>
  );
}
