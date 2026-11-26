"use client";

import { FAILURE_ACTIONS, type ThreadFailure } from "@/components/app/thread-failure";
import { Button } from "@/components/ui/button";

/**
 * Where something admits it didn't work: what happened, what it means for the owner's money,
 * and the one thing to do. Calm and plain: nothing here is an alarm.
 */
export function ThreadFailureNotice({
  failure,
  onRetry,
}: {
  readonly failure: ThreadFailure;
  readonly onRetry: () => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-card border border-border bg-card px-4 py-3"
      role="alert"
    >
      <div className="min-w-0 flex-[1_1_16rem]">
        <p className="text-ui font-medium text-ink">{failure.message}</p>
        {failure.money ? (
          <p className="mt-0.5 text-meta text-muted-foreground">{failure.money}</p>
        ) : null}
      </div>
      {failure.action ? (
        <Button onClick={onRetry} size="sm" type="button" variant="outline" className="flex-none">
          {FAILURE_ACTIONS[failure.action]}
        </Button>
      ) : null}
    </div>
  );
}
