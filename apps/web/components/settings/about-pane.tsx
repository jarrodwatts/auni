"use client";

import { ArrowUpRight, CheckCircle2, LoaderCircle, RefreshCw } from "lucide-react";

import { Mascot } from "@/components/brand/mascot";
import { CopyLine } from "@/components/ui/copy-line";
import { useAbout, useCheckUpdate } from "@/lib/data/system";

import { SETTINGS_BUTTON, SettingsBadge, SettingsRow, SettingsSection } from "./settings-layout";

const REPO_URL = "https://github.com/jarrodwatts/auni";

export function AboutPane({ highlightedTarget }: { readonly highlightedTarget: string | null }) {
  const about = useAbout(true);
  const checkUpdate = useCheckUpdate();
  const data = about.data;
  const displayVersion = (raw: string) => (raw.startsWith("v") ? raw : `v${raw}`);

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        id="setting-version"
        highlighted={highlightedTarget === "setting-version"}
        title="Auni"
        description="Open-source, single-owner AI money agent running locally on your own machine."
        action={
          <button
            type="button"
            disabled={checkUpdate.isPending}
            onClick={() => checkUpdate.mutate()}
            className={SETTINGS_BUTTON}
          >
            {checkUpdate.isPending ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            Check for updates
          </button>
        }
      >
        <SettingsRow
          label={
            <div className="flex items-center gap-3">
              <Mascot alt="" size={36} state="listening" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-body font-semibold text-ink">
                    Auni {data ? displayVersion(data.version) : ""}
                  </span>
                  {data ? (
                    <SettingsBadge tone="neutral">
                      {data.checkout ? "Source checkout" : "Installed release"}
                    </SettingsBadge>
                  ) : null}
                </div>
                <span className="mt-0.5 block text-meta text-muted-foreground">
                  MIT licensed, zero fees, self-custodied
                </span>
              </div>
            </div>
          }
        >
          {data?.update.checked && !data.update.available ? (
            <SettingsBadge tone="ok">
              <CheckCircle2 className="size-3" />
              Up to date
            </SettingsBadge>
          ) : data?.update.available && data.update.latest ? (
            <SettingsBadge tone="accent">
              {displayVersion(data.update.latest)} available
            </SettingsBadge>
          ) : null}
        </SettingsRow>

        {data?.update.available && data.update.latest ? (
          <SettingsRow
            label={`Update to ${displayVersion(data.update.latest)}`}
            description={
              data.update.note ?? "Run this in your terminal where Auni runs to upgrade in place."
            }
            stacked
          >
            <CopyLine value="auni update" command />
          </SettingsRow>
        ) : null}
      </SettingsSection>

      {data ? (
        <SettingsSection
          title="Environment & paths"
          description="Where Auni keeps its database, settings, and logs on this machine."
        >
          <SettingsRow label="Runtime">
            <code className="font-mono text-caption text-ink-soft">
              Node {data.nodeVersion} ({data.platform}/{data.arch})
            </code>
          </SettingsRow>
          <SettingsRow label="Data folder">
            <code className="max-w-[340px] truncate font-mono text-caption text-ink-soft">
              {data.dataDir}
            </code>
          </SettingsRow>
          <SettingsRow label="Settings file">
            <code className="max-w-[340px] truncate font-mono text-caption text-ink-soft">
              {data.settingsFile}
            </code>
          </SettingsRow>
        </SettingsSection>
      ) : null}

      <SettingsSection title="Open-source project" description="Source code, docs, and security.">
        <SettingsRow
          label="GitHub repository"
          description="Browse source, releases, and discussions."
        >
          <a href={REPO_URL} target="_blank" rel="noreferrer" className={SETTINGS_BUTTON}>
            jarrodwatts/auni
            <ArrowUpRight className="size-3.5" />
          </a>
        </SettingsRow>
        <SettingsRow
          label="Security model"
          description="Read how keys, sandboxing, and owner auth work."
        >
          <a
            href={`${REPO_URL}/blob/main/SECURITY.md`}
            target="_blank"
            rel="noreferrer"
            className={SETTINGS_BUTTON}
          >
            SECURITY.md
            <ArrowUpRight className="size-3.5" />
          </a>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
