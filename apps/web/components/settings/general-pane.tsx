"use client";

import type { BriefSchedule } from "@auni/shared";
import { Check, LoaderCircle, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useOwner } from "@/components/auth/owner-provider";
import { useMe, useUpdateMe } from "@/components/personalization/use-me";
import { useShowThinking } from "@/components/places/stored-state";
import { ChoicePills } from "@/components/ui/choice-pills";
import { Switch } from "@/components/ui/switch";
import { UNNAMED_OWNER } from "@/lib/account-display";
import { WIZARD_PARAM } from "@/lib/app-links";
import { cn } from "@/lib/utils";

import {
  SETTINGS_BUTTON,
  SETTINGS_INPUT,
  SETTINGS_PRIMARY_BUTTON,
  SettingsRow,
  SettingsSection,
} from "./settings-layout";

const WEEKDAYS: readonly ("mon" | "tue" | "wed" | "thu" | "fri")[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
];

type BriefMode = "daily" | "weekdays" | "custom" | "monthly" | "off";

function isWeekdays(days: readonly string[]): boolean {
  return days.length === WEEKDAYS.length && WEEKDAYS.every((d) => days.includes(d));
}

function briefModeOf(brief: BriefSchedule | null): BriefMode {
  if (!brief) return "off";
  if (brief.every === "day") return "daily";
  if (brief.every === "month") return "monthly";
  return isWeekdays(brief.every) ? "weekdays" : "custom";
}

function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function GeneralPane({ highlightedTarget }: { readonly highlightedTarget: string | null }) {
  const me = useMe();
  const router = useRouter();
  const { setOwner } = useOwner();
  const updateMe = useUpdateMe();
  const [showThinking, setShowThinking] = useShowThinking();
  const [nameInput, setNameInput] = useState<string | null>(null);
  const [savedField, setSavedField] = useState<string | null>(null);

  const displayedName = nameInput ?? me.name ?? "";
  const trimmedName = displayedName.trim();
  const nameDirty = nameInput !== null && trimmedName !== (me.name ?? "") && trimmedName.length > 0;

  const flashSaved = (field: string) => {
    setSavedField(field);
    window.setTimeout(() => setSavedField((prev) => (prev === field ? null : prev)), 2000);
  };

  const saveName = async () => {
    if (!nameDirty) {
      setNameInput(null);
      return;
    }
    const updated = await updateMe.mutateAsync({ name: trimmedName });
    setOwner(updated);
    setNameInput(null);
    flashSaved("name");
  };

  const localTz = browserTimeZone();
  const tzDiffers = Boolean(localTz && localTz !== me.timeZone);
  const briefMode = briefModeOf(me.brief);
  const briefAt = me.brief?.at ?? "08:00";

  const updateBrief = async (mode: BriefMode, at: string) => {
    const next: BriefSchedule | null =
      mode === "off"
        ? null
        : mode === "daily"
          ? { every: "day", at }
          : mode === "monthly"
            ? { every: "month", day: me.brief?.every === "month" ? me.brief.day : 1, at }
            : mode === "custom" && me.brief && Array.isArray(me.brief.every)
              ? { every: me.brief.every, at }
              : { every: [...WEEKDAYS], at };
    const updated = await updateMe.mutateAsync({ brief: next });
    setOwner(updated);
    flashSaved("brief");
  };

  const rerunWizard = () => {
    router.replace(`/app/new?${WIZARD_PARAM}=1`, { scroll: false });
  };

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        title="Profile & clock"
        description="How Auni addresses you and schedules work."
      >
        <SettingsRow
          id="setting-name"
          highlighted={highlightedTarget === "setting-name"}
          label="Display name"
          description="What Auni calls you in chats and daily briefs."
        >
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void saveName();
            }}
          >
            <input
              maxLength={40}
              autoComplete="name"
              placeholder={UNNAMED_OWNER}
              value={displayedName}
              onChange={(event) => setNameInput(event.target.value)}
              onBlur={() => void saveName()}
              className={cn(SETTINGS_INPUT, "w-[200px]")}
            />
            {nameDirty ? (
              <button
                type="submit"
                disabled={updateMe.isPending}
                className={SETTINGS_PRIMARY_BUTTON}
              >
                {updateMe.isPending ? <LoaderCircle className="size-3.5 animate-spin" /> : "Save"}
              </button>
            ) : savedField === "name" ? (
              <span className="inline-flex items-center gap-1 text-[12px] text-positive">
                <Check className="size-3.5" />
                Saved
              </span>
            ) : null}
          </form>
        </SettingsRow>

        <SettingsRow
          id="setting-timezone"
          highlighted={highlightedTarget === "setting-timezone"}
          label="Time zone"
          description="Used for watches, routines on the clock, and your daily brief."
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-[9px] bg-surface px-3 py-1.5 font-mono text-[12.5px] text-ink">
              {me.timeZone}
            </span>
            {tzDiffers && localTz ? (
              <button
                type="button"
                disabled={updateMe.isPending}
                onClick={async () => {
                  const updated = await updateMe.mutateAsync({ time_zone: localTz });
                  setOwner(updated);
                  flashSaved("tz");
                }}
                className={SETTINGS_BUTTON}
              >
                Use {localTz}
              </button>
            ) : null}
            {savedField === "tz" ? (
              <span className="inline-flex items-center gap-1 text-[12px] text-positive">
                <Check className="size-3.5" />
                Updated
              </span>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Briefs & chat display"
        description="Control proactive summaries and how Auni renders its work."
      >
        <SettingsRow
          id="setting-brief"
          highlighted={highlightedTarget === "setting-brief"}
          label="Daily brief"
          description="A concise morning digest of positions, watches, and open questions."
          stacked
        >
          <div className="flex flex-wrap items-center gap-3">
            <ChoicePills
              label="Daily brief frequency"
              options={[
                { value: "daily", name: "Every day" },
                { value: "weekdays", name: "Weekdays" },
                ...(briefMode === "custom" ? [{ value: "custom", name: "Custom days" }] : []),
                ...(briefMode === "monthly" ? [{ value: "monthly", name: "Monthly" }] : []),
                { value: "off", name: "Off" },
              ]}
              value={briefMode}
              disabled={updateMe.isPending}
              onChange={(picked) => void updateBrief(picked as BriefMode, briefAt)}
            />
            {briefMode !== "off" ? (
              <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                <span>at</span>
                <input
                  type="time"
                  value={briefAt}
                  disabled={updateMe.isPending}
                  onChange={(event) => {
                    if (/^\d{2}:\d{2}$/u.test(event.target.value)) {
                      void updateBrief(briefMode, event.target.value);
                    }
                  }}
                  className={cn(SETTINGS_INPUT, "h-8 w-auto px-2.5 font-mono text-[12.5px]")}
                />
              </label>
            ) : null}
            {savedField === "brief" ? (
              <span className="inline-flex items-center gap-1 text-[12px] text-positive">
                <Check className="size-3.5" />
                Saved
              </span>
            ) : null}
          </div>
        </SettingsRow>

        <SettingsRow
          id="setting-thinking"
          highlighted={highlightedTarget === "setting-thinking"}
          label="Show Auni's thinking"
          description="Show intermediate reasoning between tool steps on this device."
        >
          <Switch
            aria-label="Show Auni's thinking"
            checked={showThinking}
            onCheckedChange={setShowThinking}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="Onboarding"
        description="Revisit the local setup checklist for your AI brain, wallet, and personalization signals."
      >
        <SettingsRow
          id="setting-wizard"
          highlighted={highlightedTarget === "setting-wizard"}
          label="Setup wizard"
          description="Re-open the 3-step onboarding walkthrough without deleting any data."
        >
          <button type="button" onClick={rerunWizard} className={SETTINGS_BUTTON}>
            <RotateCcw className="size-3.5" />
            Re-run setup wizard
          </button>
        </SettingsRow>
      </SettingsSection>

      {updateMe.isError ? (
        <p role="alert" className="text-[12.5px] text-destructive">
          Your change could not be saved. Try again.
        </p>
      ) : null}
    </div>
  );
}
