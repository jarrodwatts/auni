import type { AppWire } from "@auni/shared";

import { formatUsd } from "@/lib/money";

/** What the sheet says before an app is turned off, and what its two buttons then do. */
export type TurningOff =
  /** Nothing of the owner's sits there: the switch flips at once. */
  | { readonly kind: "free" }
  /** Money sits there, so the sheet first says what off means. */
  | { readonly kind: "question"; readonly title: string; readonly says: readonly string[] }
  /** It can't be turned off now; `fix` is the message that starts a thread to change that. */
  | {
      readonly kind: "refused";
      readonly title: string;
      readonly why: string;
      readonly fix: string;
    };

/** What turning `app` off takes, as it stands now. */
export function turningOff(app: AppWire, name: string): TurningOff {
  if (app.stays)
    return {
      kind: "refused",
      title: `${name} can't be turned off yet`,
      why: app.stays,
      fix: `Close every position I have open on ${name}.`,
    };
  const usd = app.account?.usd;
  if (!usd || Number(usd) < 0.01) return { kind: "free" };
  return {
    kind: "question",
    title: `Turn ${name} off?`,
    says: [
      "Auni will stop acting there.",
      `Your ${formatUsd(usd)} stays yours and stays in your portfolio, and anything you already allowed still finishes.`,
    ],
  };
}
