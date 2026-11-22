import Image from "next/image";
import type { CSSProperties } from "react";

import type { DepositNetwork } from "@/lib/data/portfolio";
import { cn } from "@/lib/utils";

/**
 * How a network's mark sits on its disc, and how much of the disc it fills: Solana's on ink, and
 * the rest on white, so marks tucked together are all discs.
 */
const MARK_DISC = "bg-plate shadow-[inset_0_0_0_1px_var(--border)]";
const MARKS: Readonly<
  Partial<Record<DepositNetwork["key"], { readonly disc: string; readonly fill: number }>>
> = {
  solana: { disc: "bg-plate-ink", fill: 0.58 },
  // Marks that are a whole disc of their own (Base's is its round network mark, never its plain
  // square, which reads as a picture that failed to load). BNB Chain's disc is near-black, so in
  // the dark it takes the line a mark wears there, as every dark tile does, or its edge is lost.
  robinhood: { disc: "", fill: 1 },
  base: { disc: "", fill: 1 },
  bnb: { disc: "shadow-[inset_0_0_0_1px_var(--color-mark-line)]", fill: 1 },
};
const MARK = { disc: MARK_DISC, fill: 0.68 };

/** A network's mark. */
export function NetworkMark({
  className,
  network,
  size,
  style,
}: {
  readonly className?: string;
  readonly network: Pick<DepositNetwork, "key" | "logo">;
  readonly size: number;
  readonly style?: CSSProperties;
}) {
  const { disc, fill } = MARKS[network.key] ?? MARK;
  const drawn = Math.round(size * fill);
  return (
    <span
      className={cn(
        "grid flex-none place-items-center overflow-hidden rounded-full",
        disc,
        className,
      )}
      style={{ ...style, width: size, height: size }}
    >
      <Image alt="" height={drawn} src={network.logo} width={drawn} />
    </span>
  );
}
