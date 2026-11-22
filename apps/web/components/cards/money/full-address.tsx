import { cn } from "@/lib/utils";

/** A whole wallet address, as Auni shows one: an EVM address, or a Solana one. */
const ADDRESS = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/u;

/** Whether a card's value is one whole address, which is drawn to be checked (see FullAddress). */
export function isAddress(value: string): boolean {
  return ADDRESS.test(value);
}

/**
 * A wallet address in full, as people check one before money goes to it: the first six and last
 * four characters stand out, and it breaks into two even halves where it can't fit one line,
 * never mid-way at random.
 */
export function FullAddress({
  address,
  className,
  split = "always",
}: {
  readonly address: string;
  readonly className?: string;
  /** Two halves always, or only where a line is narrow (below the `sm` width). */
  readonly split?: "always" | "narrow";
}) {
  const half = Math.ceil(address.length / 2);
  const line = split === "always" ? "block" : "block sm:inline";
  return (
    <span className={cn("font-mono break-all text-muted-foreground", className)}>
      <span className={line}>
        <span className="font-semibold text-ink">{address.slice(0, 6)}</span>
        {address.slice(6, half)}
      </span>
      <span className={line}>
        {address.slice(half, -4)}
        <span className="font-semibold text-ink">{address.slice(-4)}</span>
      </span>
    </span>
  );
}
