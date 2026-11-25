import { KeyRound } from "lucide-react";

import { MascotArt } from "@/components/brand/mascot-art";
import { cn } from "@/lib/utils";

import styles from "./first-run.module.css";

/**
 * Auni beside a secret: facing the owner until the secret is out, then turned round with its
 * back to it and a "Not looking!" note, so nobody wonders whether it saw. Asked first to check
 * it's really them, it leans in with what it asks. It never could: the
 * secret goes only to a private field, or shows only in this browser.
 */
export function NotLooking({
  away,
  size = 132,
  className,
  pose = "calm",
  asks,
}: {
  /** The secret is out: Auni has turned its back on it. */
  readonly away: boolean;
  readonly size?: number;
  readonly className?: string;
  /** Holding the spare key up over its head before it looks away. */
  readonly pose?: "calm" | "key";
  /** Before it looks away, what it asks, leaning in: "Is that you?". */
  readonly asks?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn(styles.looker, className)}
      data-away={away || undefined}
      data-asking={(!away && asks !== undefined) || undefined}
      data-pose={pose}
      style={{ width: size, height: size }}
    >
      {pose === "key" ? (
        <span className={styles.lookerKey}>
          <KeyRound strokeWidth={2.4} />
        </span>
      ) : null}
      <span className={styles.lookerBody}>
        <MascotArt joy />
      </span>
      <span className={styles.lookerNote}>
        {away || asks === undefined ? "Not looking!" : asks}
      </span>
    </div>
  );
}
