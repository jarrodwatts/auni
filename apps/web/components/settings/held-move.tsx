"use client";

import type { DoctorFindingWire } from "@auni/shared";

import type { FailedAction } from "@/components/cards/money/failed-step";
import { useFailed } from "@/components/cards/money/use-failed";
import { DIAGNOSTICS_KEY } from "@/lib/data/system";

import { partName } from "./health";
import { Setting, SETTINGS_BUTTON, SETTINGS_PRIMARY_BUTTON } from "./settings-layout";

/**
 * Its card's taps, named apart from Health's own Check again above them, which reads every part
 * again. Only these show: a held move offers no Try again, and Ask Auni needs a chat.
 */
const LABEL: Partial<Record<FailedAction, readonly [idle: string, busy: string]>> = {
  check: ["Check status", "Checking"],
  close: ["Close it", "Closing"],
  keep: ["Not yet", "Not yet"],
};

/** Never run: a held move offers no Try again (see failedStep). */
const noRetry = async () => undefined;

/**
 * A held move in no chat (a withdrawal started from Settings, or one whose chat was deleted),
 * which has no card to open: Health offers its card's own Check again (as Check status) and Close in place, and
 * reads itself again after either, so a move that settles leaves the list.
 */
export function HeldMove({ finding }: { readonly finding: DoctorFindingWire }) {
  const id = finding.heldMove!;
  const failure = { kind: null, said: finding.says, where: "", retryable: false, held: true };
  const failed = useFailed([{ key: id, failure }], DIAGNOSTICS_KEY, noRetry, undefined);
  const step = failed.steps.get(id)!;
  const act = failed.act({ key: id, label: finding.says, reason: step.reason });
  return (
    <Setting
      label={partName(finding.check)}
      hint={
        <>
          {step.reason}
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
