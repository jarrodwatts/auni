"use client";

import { ArrowUpRight, ChevronDown, Laptop, MessageSquare, Server } from "lucide-react";
import { useState } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { useMe } from "@/components/personalization/use-me";
import { CopyLine } from "@/components/ui/copy-line";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useHandover } from "@/lib/data/handover";
import { cn } from "@/lib/utils";

/**
 * Environment selector beneath the composer (left side): names the machine
 * running Auni and whether it stays on 24/7 or pauses when this computer sleeps.
 * Its popover shows Tailscale cross-device sync, connected Telegram, and a
 * direct path to hand Auni over to an always-on machine.
 */
export function EnvironmentPicker() {
  const me = useMe();
  const { openSettings } = useAppDialogs();
  const [open, setOpen] = useState(false);

  const staysOn = me.reach.staysOn;
  const alwaysOn = staysOn.stays;
  const machine = me.reach.machine;
  const tailscaleAddress =
    me.reach.through === "tailscale" && me.reach.address ? me.reach.address : null;
  const telegramPaired = me.channels.some((channel) => channel.id === "telegram" && channel.paired);
  const handover = useHandover({ enabled: open && !alwaysOn });

  const onlineOthers =
    handover.data?.tailnet.state === "on"
      ? handover.data.tailnet.machines.filter(
          (peer) => !peer.here && peer.runsAuni && peer.online,
        )
      : [];

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Running on ${machine}, ${alwaysOn ? "always on" : "local, pauses on sleep"}. Environment details.`}
          className="flex h-7 max-w-[240px] items-center gap-1.5 rounded-[8px] px-2 text-[12.5px] text-muted-foreground transition-colors duration-150 outline-none hover:bg-foreground/[0.045] hover:text-ink focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-foreground/[0.05] data-[state=open]:text-ink"
        >
          <span
            aria-hidden
            className={cn(
              "size-2 flex-none rounded-full",
              alwaysOn ? "bg-positive" : "bg-waiting",
            )}
          />
          <span className="truncate font-medium text-ink-soft">{machine}</span>
          <span aria-hidden className="h-3 w-px flex-none bg-foreground/[0.12]" />
          <span className="flex-none">{alwaysOn ? "Always on" : "Local"}</span>
          <ChevronDown aria-hidden className="size-3 flex-none text-faint" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={8}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-[336px] rounded-[16px] border-foreground/[0.08] p-3 shadow-menu"
      >
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex size-8 flex-none items-center justify-center rounded-full bg-surface text-ink-soft">
            {alwaysOn ? (
              <Server aria-hidden className="size-4" />
            ) : (
              <Laptop aria-hidden className="size-4" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-[14px] font-semibold text-ink">{machine}</p>
              <span
                className={cn(
                  "flex flex-none items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium",
                  alwaysOn
                    ? "bg-positive/[0.12] text-positive"
                    : "bg-warning-surface text-warning",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full",
                    alwaysOn ? "bg-positive" : "bg-waiting",
                  )}
                />
                {alwaysOn ? "Always on" : "Pauses on sleep"}
              </span>
            </div>
            <p className="mt-1 text-[12.5px] leading-[1.45] text-muted-foreground">
              {alwaysOn
                ? "Watches, schedules, and Auto threads keep running 24/7. Every device you open syncs live with this machine."
                : "Running on this computer. Watches, schedules, and Auto threads pause when it sleeps."}
            </p>
          </div>
        </div>

        {tailscaleAddress ? (
          <div className="mt-3 border-t border-foreground/[0.06] pt-3">
            <p className="mb-1.5 text-[11.5px] font-medium text-muted-foreground">
              Open from phone or another device
            </p>
            <CopyLine value={tailscaleAddress} />
          </div>
        ) : null}

        {telegramPaired ? (
          <div className="mt-3 flex items-center gap-2 rounded-[10px] bg-surface px-2.5 py-2 text-[12px] text-ink-soft">
            <MessageSquare aria-hidden className="size-3.5 flex-none text-positive" />
            <span className="min-w-0 flex-1">
              Telegram connected. Cards and alerts reach your phone.
            </span>
          </div>
        ) : null}

        {!alwaysOn ? (
          <div className="mt-3 border-t border-foreground/[0.06] pt-3">
            {onlineOthers.length > 0 ? (
              <div className="mb-2">
                <p className="mb-1.5 text-[11.5px] font-medium text-muted-foreground">
                  Online Tailscale machines ready for handover
                </p>
                <div className="flex flex-col gap-1">
                  {onlineOthers.slice(0, 3).map((peer) => (
                    <button
                      key={peer.id}
                      type="button"
                      onClick={() => {
                        setOpen(false);
                        openSettings("remote");
                      }}
                      className="flex w-full items-center justify-between gap-2 rounded-[9px] px-2 py-1.5 text-left text-[13px] text-ink transition-colors hover:bg-foreground/[0.045]"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span aria-hidden className="size-1.5 flex-none rounded-full bg-positive" />
                        <span className="truncate font-medium">{peer.name}</span>
                      </span>
                      <span className="flex-none text-[11.5px] text-primary">Move here</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openSettings("remote");
              }}
              className="flex w-full items-center justify-between gap-2 rounded-[10px] bg-surface px-3 py-2 text-[12.5px] font-medium text-ink transition-colors hover:bg-foreground/[0.06]"
            >
              <span>Move to an always-on machine</span>
              <ArrowUpRight aria-hidden className="size-3.5 text-muted-foreground" />
            </button>
          </div>
        ) : (
          <div className="mt-3 border-t border-foreground/[0.06] pt-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openSettings("remote");
              }}
              className="flex w-full items-center justify-between gap-2 rounded-[9px] px-2 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-foreground/[0.045] hover:text-ink"
            >
              <span>Environment settings</span>
              <ArrowUpRight aria-hidden className="size-3.5 text-faint" />
            </button>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
