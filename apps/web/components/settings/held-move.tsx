"use client";

import type { DoctorFindingWire } from "@auni/shared";

import type { FailedAction } from "@/components/cards/money/failed-step";
import { useFailed } from "@/components/cards/money/use-failed";
import { DIAGNOSTICS_KEY } from "@/lib/data/system";

import { Setting, SETTINGS_BUTTON, SETTINGS_PRIMARY_BUTTON } from "./settings-layout";

type Held = NonNullable<DoctorFindingWire["heldMove"]>;

/**
 * Its card's taps, named apart from Health's own Check again above them, which reads every part
 * again. Only these show: a held move offers no Try again, and Ask Auni needs a chat. Dismissing
 * never reads as cancelling the money, which it can't.
 */
const LABEL: Partial<Record<FailedAction, readonly [idle: string, busy: string]>> = {
  check: ["Check status", "Checking"],
  close: ["Dismiss card", "Dismissing"],
  keep: ["Keep checking", "Keep checking"],
};

/**
 * Health's own words for a held move, apart from its card's: why it is held and what stays true,
 * or, once Dismiss card was tapped, what that means, naming the move again so that with two held
 * the owner can't dismiss the wrong one.
 */
function heldMoveWords({ summary, why }: Held, dismissing: boolean): string {
  if (!dismissing)
    return `${why} Auni won't send it again, and Money shows what you hold either way.`;
  // Every card's summary starts with its verb ("Withdraw $20 to ..."), so it reads on from "to".
  const move = summary.charAt(0).toLowerCase() + summary.slice(1);
  return `Dismiss the card to ${move}? Auni stops checking it. Dismissing can't undo or cancel the move, and Money shows whether it went.`;
}

/** Never run: a held move offers no Try again (see failedStep). */
const noRetry = async () => undefined;

/**
 * A held move in no chat (a withdrawal started from Settings, or one whose chat was deleted),
 * which has no card to open: Health offers its card's own taps in place, under the move itself,
 * and reads itself again after either, so a move that settles leaves the list.
 */
export function HeldMove({ move }: { readonly move: Held }) {
  const failure = { kind: null, said: move.why, where: "", retryable: false, held: true };
  const failed = useFailed([{ key: move.id, failure }], DIAGNOSTICS_KEY, noRetry, undefined);
  const step = failed.steps.get(move.id)!;
  const words = heldMoveWords(move, step.actions.includes("keep"));
  const act = failed.act({ key: move.id, label: move.summary, reason: words });
  return (
    <Setting
      label={move.summary}
      hint={
        <>
          {words}
          {failed.problem ? (
            <span aria-live="polite" className="mt-1 block text-ink">
              {failed.problem}
            </span>
          ) : null}
        </>
      }
    >
      <div className="flex flex-wrap gap-2">
        {step.actions.map((action, index) => (
          <button
            key={action}
            type="button"
            disabled={failed.busy !== null}
            onClick={() => act(action)}
            className={index === 0 ? SETTINGS_PRIMARY_BUTTON : SETTINGS_BUTTON}
          >
            {LABEL[action]?.[failed.busy === action ? 1 : 0]}
          </button>
        ))}
      </div>
    </Setting>
  );
}
