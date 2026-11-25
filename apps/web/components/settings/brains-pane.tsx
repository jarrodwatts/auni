"use client";

import { AlertTriangle, LoaderCircle } from "lucide-react";

import { BrainRow } from "@/components/brains/brain-row";
import { useMe } from "@/components/personalization/use-me";
import { ChoicePills } from "@/components/ui/choice-pills";
import { CoreApiError } from "@/lib/core";
import { useBrains, useSetPreferredBrain } from "@/lib/data/brains";

import { SettingsRow, SettingsSection } from "./settings-layout";

/**
 * Local AI CLI brains: detect installed CLIs, install or sign in from any device, and pick
 * which brain runs first (with automatic fallback if one hits a usage limit).
 */
export function BrainsPane({ highlightedTarget }: { readonly highlightedTarget: string | null }) {
  const me = useMe();
  const brains = useBrains();
  const setPreferred = useSetPreferredBrain();
  const rows = brains.data?.rows ?? [];
  const machine =
    me.reach.through === "tailscale"
      ? new URL(me.reach.address).hostname.split(".")[0] || "your machine"
      : "this computer";

  return (
    <div className="flex flex-col gap-5">
      {brains.data?.blocked ? (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-card border border-waiting/30 bg-waiting-surface px-4 py-3 text-meta leading-[1.5] text-waiting"
        >
          <AlertTriangle className="mt-0.5 size-4 flex-none" />
          <span>{brains.data.blocked}</span>
        </div>
      ) : null}

      {rows.length > 1 ? (
        <SettingsSection
          id="setting-preferred-brain"
          highlighted={highlightedTarget === "setting-preferred-brain"}
          title="Preferred brain"
          description="Auni asks your preferred AI first and automatically falls back to another ready brain if one hits a usage limit."
        >
          <SettingsRow label="Ask first" description="Takes effect immediately on the next turn.">
            <ChoicePills
              label="Preferred AI brain"
              value={me.preferredBrain ?? ""}
              disabled={setPreferred.isPending}
              options={[
                { value: "", name: "Auto" },
                ...rows.map(({ row }) => ({ value: row.id, name: row.name })),
              ]}
              onChange={(picked) => setPreferred.mutate(picked || null)}
            />
          </SettingsRow>
          {setPreferred.isError ? (
            <div className="px-4 py-2.5 text-meta text-destructive sm:px-5">
              {setPreferred.error instanceof CoreApiError && setPreferred.error.detail
                ? setPreferred.error.detail
                : "Could not save preferred brain. Check if BRAIN is set in your shell environment."}
            </div>
          ) : null}
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Connected AI CLIs"
        description={`Auni runs your own AI CLI inside a sandboxed box on ${machine}, using your existing subscription login with no extra API markup.`}
      >
        <div className="p-4 sm:p-5">
          {brains.isPending && rows.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-meta text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Checking local AI CLIs…
            </div>
          ) : (
            <ul className="flex flex-col gap-3">
              {rows.map((item) => (
                <BrainRow key={item.row.id} item={item} machine={machine} />
              ))}
            </ul>
          )}
        </div>
      </SettingsSection>
    </div>
  );
}
