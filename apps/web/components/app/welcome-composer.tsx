"use client";

import type { ModelSelectionWire, ThreadActMode } from "@auni/shared";
import { useState } from "react";

import { AutonomyPicker } from "@/components/app/autonomy-picker";
import { Composer } from "@/components/app/composer";
import { EnvironmentPicker } from "@/components/app/environment-picker";
import { ModelPicker } from "@/components/app/model-picker";
import { useStartConversation } from "@/components/app/use-start-conversation";
import type { MascotReadingTarget } from "@/components/brand/interactive-mascot";
import { useMe, useUpdateMe } from "@/components/personalization/use-me";

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
  const [actMode, setActMode] = useState<ThreadActMode>("ask_first");
  const [budgetUsd, setBudgetUsd] = useState<string>("0");

  const handleModelChange = (next: ModelSelectionWire) => {
    setModelSelection(next);
    // Picking a model on a new thread also remembers it as the default for future threads.
    updateMe.mutate({ default_model_selection: next });
  };

  const handleAutonomyChange = (next: {
    readonly actMode: ThreadActMode;
    readonly budgetUsd?: string;
  }) => {
    setActMode(next.actMode);
    if (next.budgetUsd !== undefined) setBudgetUsd(next.budgetUsd);
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
        footerStrip={
          <>
            <EnvironmentPicker />
            <AutonomyPicker
              actMode={actMode}
              budgetUsd={budgetUsd}
              onChange={handleAutonomyChange}
              disabled={busy}
            />
          </>
        }
        onSubmit={(message) =>
          start(message, undefined, {
            modelSelection,
            actMode,
            ...(actMode === "within_limits" && Number(budgetUsd) > 0 ? { budgetUsd } : {}),
          })
        }
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
