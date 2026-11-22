import type { ReactNode } from "react";

import { Mascot } from "@/components/brand/mascot";
import { cn } from "@/lib/utils";

/**
 * Auni saying why, in its own voice: the mascot and a soft bubble. A pick's
 * detail and the tape share it, so Auni reads the same wherever it speaks.
 */
export function AuniNote({
  children,
  className,
}: {
  readonly children: ReactNode;
  /** Where it sits: its margins in the surface around it. */
  readonly className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <div className="auni-note rounded-[16px] bg-primary/[0.07] px-3.5 pt-2.5 pb-3">
        <p className="pr-10 text-[11.5px] leading-4 font-semibold text-primary/80">
          What Auni thinks
        </p>
        <p className="mt-1 text-[13.5px] leading-[1.45] text-pretty text-ink">{children}</p>
      </div>
      {/* Perched on the box's corner, the one saying it. */}
      <Mascot
        alt=""
        size={32}
        state="color"
        className="auni-note-mascot absolute -top-4 right-2.5 drop-shadow-[0_4px_8px_--alpha(var(--color-shade-blue)/18%)]"
      />
    </div>
  );
}
