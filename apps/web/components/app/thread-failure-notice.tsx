"use client";

import { RefreshCw } from "lucide-react";

import type { ThreadFailure } from "@/components/app/thread-failure";
import { Button } from "@/components/ui/button";

/** The one place a conversation admits something went wrong: one sentence, one Try again. */
export function ThreadFailureNotice({
  failure,
  onRetry,
}: {
  readonly failure: ThreadFailure;
  readonly onRetry: () => void;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-primary/[0.14] bg-card/60 py-2.5 pr-2.5 pl-4"
      role="alert"
    >
      <p className="min-w-0 flex-1 text-sm leading-5 text-foreground">{failure.message}</p>
      {failure.action ? (
        <Button onClick={onRetry} size="sm" type="button" variant="outline" className="flex-none">
          <RefreshCw aria-hidden />
          Try again
        </Button>
      ) : null}
    </div>
  );
}
