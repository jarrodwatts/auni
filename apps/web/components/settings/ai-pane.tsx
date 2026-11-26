"use client";

import { LoaderCircle } from "lucide-react";

import { BrainRow } from "@/components/brains/brain-row";
import { useMe } from "@/components/personalization/use-me";
import { ChoicePills } from "@/components/ui/choice-pills";
import { CoreApiError } from "@/lib/core";
import { useBrains, useSetPreferredBrain } from "@/lib/data/brains";

import { Refusal, Setting, SettingsGroup, useJumpTarget } from "./settings-layout";

/**
 * Your AI: each brain Auni can think with on the owner's own login, made ready from here as
 * first run does it, and, with more than one, which Auni asks first.
 */
export function AiPane() {
  const me = useMe();
  const brains = useBrains();
  const preferred = useSetPreferredBrain();
  const rows = brains.data?.rows ?? [];
  const machine = brains.data?.machine ?? me.reach.machine;
  const { ref } = useJumpTarget<HTMLElement>("setting-brains");

  return (
    <>
      {brains.data?.blocked ? (
        <p
          role="alert"
          className="rounded-card border border-waiting/30 bg-waiting-surface px-4 py-3 text-meta leading-[1.5] text-waiting"
        >
          {brains.data.blocked}
        </p>
      ) : null}
      <section ref={ref} id="setting-brains" aria-label="Your AI" className="scroll-mt-6">
        {brains.isPending && rows.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-10 text-meta text-muted-foreground">
            <LoaderCircle aria-hidden className="size-4 animate-spin" />
            Looking for Claude and Codex on {machine}
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {rows.map((item) => (
              <BrainRow key={item.row.id} item={item} machine={machine} />
            ))}
          </ul>
        )}
        <p className="mt-3 px-1 text-meta leading-[1.5] text-muted-foreground">
          Auni uses your own Claude or ChatGPT login on {machine}, with nothing extra to pay.
        </p>
      </section>
      {rows.length > 1 ? (
        <SettingsGroup>
          <Setting
            id="setting-first-brain"
            label="Which AI goes first"
            hint="If it reaches its usage limit, Auni carries on with the other."
            stacked
          >
            <ChoicePills
              label="Which AI goes first"
              value={me.preferredBrain ?? ""}
              disabled={preferred.isPending}
              options={[
                { value: "", name: "Either" },
                ...rows.map(({ row }) => ({ value: row.id, name: row.name })),
              ]}
              onChange={(picked) => preferred.mutate(picked || null)}
            />
            {preferred.isError ? (
              <div className="mt-2">
                <Refusal>
                  {preferred.error instanceof CoreApiError && preferred.error.detail
                    ? preferred.error.detail
                    : "Couldn't save that. Try again."}
                </Refusal>
              </div>
            ) : null}
          </Setting>
        </SettingsGroup>
      ) : null}
    </>
  );
}
