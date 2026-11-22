"use client";

import { LoaderCircle } from "lucide-react";

import { AppKeysNeeded, AppSettings } from "@/components/apps/app-keys";
import { AppMark } from "@/components/apps/app-mark";
import { AppPairing } from "@/components/apps/app-pairing";
import { AppSwitch } from "@/components/apps/app-switch";
import { useStartConversation } from "@/components/app/use-start-conversation";
import { useMe, useUpdateMe } from "@/components/personalization/use-me";
import { ChoicePills } from "@/components/ui/choice-pills";
import { useApps } from "@/lib/data/apps";

import { SettingsBadge, SettingsRow, SettingsSection } from "./settings-layout";

/**
 * Messaging channels (read dynamically from apps with the `reach` job) and where Auni sends
 * proactive notices and daily briefs.
 */
export function ChannelsPane({ highlightedTarget }: { readonly highlightedTarget: string | null }) {
  const me = useMe();
  const updateProfile = useUpdateMe();
  const apps = useApps();
  const { busy, start } = useStartConversation();

  const channelApps = (apps.data?.apps ?? []).filter((app) => app.pairing !== null);
  const paired = me.channels.filter((channel) => channel.paired);
  const settingsFile = apps.data?.settingsFile ?? "~/.auni/.env";

  return (
    <div className="flex flex-col gap-5">
      <SettingsSection
        id="setting-home-channel"
        highlighted={highlightedTarget === "setting-home-channel"}
        title="When Auni speaks up"
        description="Choose where Auni sends landing notifications, triggered watches, and your daily brief."
      >
        <SettingsRow
          label="Default channel"
          description={
            paired.length === 0
              ? "Pair a chat app below to also receive messages away from this browser."
              : updateProfile.isError
                ? "That couldn't be saved. Try again."
                : "Applied immediately for future alerts and briefs."
          }
          stacked
        >
          <ChoicePills
            label="When Auni speaks up"
            options={[
              { value: "", name: "Where I last talked" },
              { value: "web", name: "Only this app" },
              ...paired.map((channel) => ({ value: channel.id, name: `${channel.name} too` })),
            ]}
            value={me.home ?? ""}
            disabled={updateProfile.isPending}
            onChange={(picked) => updateProfile.mutate({ home_channel: picked || null })}
          />
        </SettingsRow>
      </SettingsSection>

      <div id="setting-channel-apps" className="scroll-mt-4 flex flex-col gap-4">
        {apps.isPending && channelApps.length === 0 ? (
          <div className="flex items-center justify-center gap-2 rounded-[16px] border border-foreground/[0.08] bg-card py-10 text-[13px] text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Loading chat apps…
          </div>
        ) : channelApps.length === 0 ? (
          <div className="rounded-[16px] border border-foreground/[0.08] bg-card px-5 py-6 text-[13px] text-muted-foreground">
            No chat channel apps are installed in this build.
          </div>
        ) : (
          channelApps.map((app) => {
            const statusTone = !app.on ? "neutral" : app.pairing === "paired" ? "ok" : "warn";
            const statusText = !app.on
              ? "Off"
              : app.pairing === "paired"
                ? "Paired"
                : app.pairing === "ready"
                  ? "Needs pairing"
                  : "Needs setup";
            return (
              <SettingsSection
                key={app.id}
                highlighted={highlightedTarget === "setting-channel-apps"}
                title={app.name}
                description={app.does ?? undefined}
                action={
                  <div className="flex items-center gap-2.5">
                    <SettingsBadge tone={statusTone}>{statusText}</SettingsBadge>
                    <AppMark id={app.id} name={app.name} size={28} />
                  </div>
                }
              >
                <div className="flex flex-col gap-5 p-4 sm:p-5">
                  {app.canSwitch ? (
                    <AppSwitch
                      app={app}
                      name={app.name}
                      busy={busy}
                      onAsk={(prompt) => void start(prompt)}
                    />
                  ) : null}
                  <AppKeysNeeded app={app} />
                  <AppPairing app={app} name={app.name} />
                  <AppSettings app={app} settingsFile={settingsFile} />
                </div>
              </SettingsSection>
            );
          })
        )}
      </div>
    </div>
  );
}
