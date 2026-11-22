"use client";

import { X } from "lucide-react";
import { useEffect, useState } from "react";

import { useRefreshMe } from "@/components/personalization/use-me";
import { auniDialogCardClass, auniDialogOverlayClass } from "@/components/ui/auni-dialog";
import { Dialog, DialogContent, DialogDescription, focusDialogTitle } from "@/components/ui/dialog";
import type { SettingsSection } from "@/lib/app-links";
import { cn } from "@/lib/utils";

import { AboutPane } from "./about-pane";
import { AppearancePane } from "./appearance-pane";
import { BrainsPane } from "./brains-pane";
import { ChannelsPane } from "./channels-pane";
import { DiagnosticsPane } from "./diagnostics-pane";
import { GeneralPane } from "./general-pane";
import { NetworkPane } from "./network-pane";
import { PersonalizationPane } from "./personalization-pane";
import { RemotePane } from "./remote-pane";
import { sectionMeta } from "./settings-search";
import { SettingsSidebar } from "./settings-sidebar";
import { WalletPane } from "./wallet-pane";

/**
 * T3 Code-inspired Settings dialog: grouped left sidebar with instant search (`/` or `Cmd+F`),
 * immediate-save controls, and dedicated panes for General, Appearance, Personalization,
 * AI Brains, Wallet & Keys, Channels, Remote access, Network & RPCs, Diagnostics, and About.
 */
export function SettingsDialog({
  open,
  section,
  onSectionChange,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly section: SettingsSection;
  readonly onSectionChange: (section: SettingsSection) => void;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const refreshMe = useRefreshMe();
  const [highlightedTarget, setHighlightedTarget] = useState<string | null>(null);
  const current = sectionMeta(section);

  useEffect(() => {
    if (open) refreshMe();
  }, [open, refreshMe]);

  // Scroll to and pulse-highlight a setting when jumped to from Settings search.
  useEffect(() => {
    if (!highlightedTarget) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const el = document.getElementById(highlightedTarget);
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const clear = window.setTimeout(() => setHighlightedTarget(null), 2200);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(clear);
    };
  }, [highlightedTarget, section]);

  const close = () => {
    setHighlightedTarget(null);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        className={cn(
          auniDialogCardClass,
          "flex h-[min(92dvh,800px)] w-[min(96vw,1040px)] max-w-none flex-col overflow-hidden p-0 sm:max-w-[1040px] md:flex-row md:p-0",
        )}
        overlayClassName={auniDialogOverlayClass}
        showCloseButton={false}
        onOpenAutoFocus={focusDialogTitle}
      >
        <SettingsSidebar
          active={current.id}
          onSelect={(next) => {
            setHighlightedTarget(null);
            onSectionChange(next);
          }}
          onJump={(nextSection, targetId) => {
            onSectionChange(nextSection);
            setHighlightedTarget(targetId);
          }}
        />

        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          {/* Sticky section header */}
          <header className="flex flex-none items-start justify-between gap-4 border-b border-foreground/[0.06] px-5 py-4 sm:px-7 sm:py-5">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <current.icon
                  aria-hidden
                  className="size-4.5 text-muted-foreground"
                  strokeWidth={1.9}
                />
                <h3 className="text-[18px] leading-6 font-semibold tracking-[-0.02em] text-ink">
                  {current.label}
                </h3>
              </div>
              <DialogDescription className="mt-1 text-[13px] leading-[1.45] text-muted-foreground">
                {current.description}
              </DialogDescription>
            </div>
            <button
              type="button"
              aria-label="Close settings"
              onClick={close}
              className="grid size-8 flex-none place-items-center rounded-[9px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/35 focus-visible:outline-none"
            >
              <X className="size-4" />
            </button>
          </header>

          {/* Scrollable content body */}
          <div
            key={current.id}
            className="auni-field-in min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6"
          >
            <div className="mx-auto w-full max-w-[680px] pb-6">
              {current.id === "general" ? (
                <GeneralPane highlightedTarget={highlightedTarget} />
              ) : current.id === "appearance" ? (
                <AppearancePane highlightedTarget={highlightedTarget} />
              ) : current.id === "personalization" ? (
                <PersonalizationPane highlightedTarget={highlightedTarget} />
              ) : current.id === "brains" ? (
                <BrainsPane highlightedTarget={highlightedTarget} />
              ) : current.id === "wallet" ? (
                <WalletPane highlightedTarget={highlightedTarget} />
              ) : current.id === "channels" ? (
                <ChannelsPane highlightedTarget={highlightedTarget} />
              ) : current.id === "remote" ? (
                <RemotePane highlightedTarget={highlightedTarget} />
              ) : current.id === "network" ? (
                <NetworkPane highlightedTarget={highlightedTarget} />
              ) : current.id === "diagnostics" ? (
                <DiagnosticsPane highlightedTarget={highlightedTarget} />
              ) : (
                <AboutPane highlightedTarget={highlightedTarget} />
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
