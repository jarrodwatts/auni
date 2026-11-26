"use client";

import type { ModelSelectionWire } from "@auni/shared";
import { useState } from "react";

import { Composer } from "@/components/app/composer";
import { ModelPicker } from "@/components/app/model-picker";
import { useStartConversation } from "@/components/app/use-start-conversation";
import type { MascotReadingTarget } from "@/components/brand/interactive-mascot";
import { useMe, useUpdateMe } from "@/components/personalization/use-me";

/** A take as an owner would say one: what the box is for, said by example. */
export const NEW_TAKE_PLACEHOLDER = "AI power demand keeps climbing";

export function WelcomeComposer({
  onCaretActivity,
}: {
  readonly onCaretActivity?: (target: MascotReadingTarget) => void;
}) {
  const me = useMe();
  const updateMe = useUpdateMe();
  const { busy, error, start } = useStartConversation();
  const [modelSelection, setModelSelection] = useState<ModelSelectionWire | null>(
    () => me.defaultModelSelection ?? null,
  );

  const handleModelChange = (next: ModelSelectionWire) => {
    setModelSelection(next);
    // Picking a model on a new take also remembers it as the default for the next.
    updateMe.mutate({ default_model_selection: next });
  };

  return (
    <div className="w-full max-w-[680px]" data-slot="welcome-composer">
      <Composer
        busy={busy}
        draftKey="new"
        autoFocus
        onCaretActivity={onCaretActivity}
        inlineControl={
          <ModelPicker value={modelSelection} onChange={handleModelChange} disabled={busy} />
        }
        onSubmit={(message) => start(message, undefined, { modelSelection })}
        placeholder={NEW_TAKE_PLACEHOLDER}
      />
      {error && (
        <p role="alert" className="mt-2 text-center text-caption text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
