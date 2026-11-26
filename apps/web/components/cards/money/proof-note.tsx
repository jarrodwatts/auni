import { KeyRound } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Says, before the tap, that this one also checks the owner is there: a withdrawal to a new
 * address, or a transaction Auni can't vouch for. Core judges that from the tap itself: from a
 * browser paired minutes ago, it asks nothing more.
 */
export function ProofNote({
  children,
  className,
}: {
  readonly children: ReactNode;
  /** Where it sits: its margins in the surface around it. */
  readonly className?: string;
}) {
  return (
    <p
      className={cn(
        "flex gap-2.5 rounded-control border border-foreground/[0.08] px-3.5 py-3 text-meta leading-[1.5] text-muted-foreground",
        className,
      )}
    >
      <KeyRound aria-hidden className="mt-0.5 size-4 flex-none text-primary" />
      <span>{children}</span>
    </p>
  );
}
