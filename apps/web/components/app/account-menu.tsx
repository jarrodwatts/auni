"use client";

import "./account-menu.css";

import { ChevronsUpDown, Plus, Settings } from "lucide-react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { useCloseMobileThreadMenu } from "@/components/app/mobile-thread-menu";
import { VaultArt } from "@/components/brand/vault-art";
import { useMe } from "@/components/personalization/use-me";
import { useArriving } from "@/components/places/arriving";
import { FOLD_FADE, ROW_CLASS_NAME } from "@/components/places/sidebar-rows";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { UNNAMED_OWNER } from "@/lib/account-display";
import { cn } from "@/lib/utils";

const ITEM_CLASS_NAME = "h-9 gap-2.5 rounded-control px-2.5 text-ui text-ink";

/**
 * The owner, and the computer Auni runs on: the door to money-in and settings. It opens a short
 * menu in place, so whatever sits underneath stays put while a popup opens over it.
 */
export function AccountMenu() {
  const closeMobileMenu = useCloseMobileThreadMenu();
  const me = useMe();
  const name = me.name ?? UNNAMED_OWNER;
  const { openAddMoney, openSettings } = useAppDialogs();
  const arriving = useArriving();

  return (
    <div className="relative flex-none p-2" data-arriving={arriving || undefined}>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              ROW_CLASS_NAME,
              "auni-account-settings-link w-full gap-2.5 px-1.5 py-1.5 text-left data-[state=open]:before:bg-foreground/[0.06]",
            )}
          >
            <span className="auni-account-avatar relative z-[1] flex size-8 flex-none items-center justify-center rounded-full">
              <VaultArt className="auni-account-mark absolute inset-0 size-8" />
            </span>
            <span className={cn("relative z-[1] min-w-0 flex-1", FOLD_FADE)}>
              <span className="block truncate text-ui font-semibold text-ink">{name}</span>
              <span className="mt-0.5 block truncate text-caption text-muted-foreground">
                On {me.reach.machine}
              </span>
            </span>
            <ChevronsUpDown
              aria-hidden
              className={cn("size-3.5 flex-none text-faint", FOLD_FADE)}
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          side="top"
          sideOffset={6}
          className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-[220px] rounded-card p-1.5"
        >
          <DropdownMenuItem
            className={ITEM_CLASS_NAME}
            onSelect={() => {
              closeMobileMenu();
              openAddMoney();
            }}
          >
            <Plus aria-hidden className="size-4 text-muted-foreground" />
            Add money
          </DropdownMenuItem>
          <DropdownMenuItem
            className={ITEM_CLASS_NAME}
            onSelect={() => {
              closeMobileMenu();
              openSettings();
            }}
          >
            <Settings aria-hidden className="size-4 text-muted-foreground" />
            Settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
