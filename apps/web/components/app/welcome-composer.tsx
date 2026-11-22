"use client";

import { useStartConversation } from "@/components/app/use-start-conversation";
import { Composer } from "@/components/app/composer";
import type { MascotReadingTarget } from "@/components/brand/interactive-mascot";

export function WelcomeComposer({
  onCaretActivity,
}: {
  readonly onCaretActivity?: (target: MascotReadingTarget) => void;
}) {
  const { busy, error, start } = useStartConversation();

  return (
    <div className="w-full max-w-[680px]">
      <Composer
        busy={busy}
        draftKey="new"
        autoFocus
        onCaretActivity={onCaretActivity}
        onSubmit={(message) => start(message)}
        placeholder="Peptides go mainstream by 2028"
      />
      {error && (
        <p role="alert" className="mt-2 text-center text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
