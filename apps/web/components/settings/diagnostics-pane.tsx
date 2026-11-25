"use client";

import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  Copy,
  FileText,
  Info,
  LoaderCircle,
  RefreshCw,
  Wrench,
} from "lucide-react";
import { useState } from "react";

import { PairAgain } from "@/components/auth/pair-again";
import { CopyLine } from "@/components/ui/copy-line";
import { CoreApiError } from "@/lib/core";
import { useDiagnostics, useLogs, useRunRepair } from "@/lib/data/system";
import { cn } from "@/lib/utils";

import {
  SETTINGS_BUTTON,
  SETTINGS_PRIMARY_BUTTON,
  SettingsBadge,
  SettingsRow,
  SettingsSection,
} from "./settings-layout";

const GITHUB_ISSUES = "https://github.com/jarrodwatts/auni/issues/new";

export function DiagnosticsPane({
  highlightedTarget,
}: {
  readonly highlightedTarget: string | null;
}) {
  const diag = useDiagnostics(true);
  const repair = useRunRepair();
  const [logsOpen, setLogsOpen] = useState(false);
  const logs = useLogs(logsOpen);

  const [repairingId, setRepairingId] = useState<string | null>(null);
  const [repairNotice, setRepairNotice] = useState<{
    readonly ok: boolean;
    readonly text: string;
    readonly command?: string;
  } | null>(null);
  const [pairAgain, setPairAgain] = useState(false);
  const [copiedLogs, setCopiedLogs] = useState(false);

  const findings = diag.data?.findings ?? [];
  const fixCount = findings.filter((f) => f.status === "fix").length;
  const noteCount = findings.filter((f) => f.status === "note").length;
  const okCount = findings.filter((f) => f.status === "ok").length;

  const runFix = async (id: string) => {
    setRepairingId(id);
    setRepairNotice(null);
    setPairAgain(false);
    try {
      const result = await repair.mutateAsync(id);
      setRepairNotice({
        ok: result.ok,
        text: result.message,
        ...(result.sudoCommand ? { command: result.sudoCommand } : {}),
      });
    } catch (error) {
      if (error instanceof CoreApiError && error.code === "pair_again") {
        setPairAgain(true);
      } else {
        setRepairNotice({
          ok: false,
          text:
            (error instanceof CoreApiError && error.detail) ||
            "That repair didn't complete. Run `auni doctor --fix` in your terminal.",
        });
      }
    } finally {
      setRepairingId(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Live auni doctor */}
      <SettingsSection
        id="setting-doctor"
        highlighted={highlightedTarget === "setting-doctor"}
        title="Health checks (auni doctor)"
        description="Live inspection of your database, job runner, background service, RPCs, AI brains, wallet, apps, and Tailscale."
        action={
          <button
            type="button"
            disabled={diag.isFetching}
            onClick={() => void diag.refetch()}
            className={SETTINGS_BUTTON}
          >
            <RefreshCw className={cn("size-3.5", diag.isFetching && "animate-spin")} />
            Re-run
          </button>
        }
      >
        <SettingsRow
          label="Status summary"
          description={
            diag.data?.ranAt
              ? `Checked at ${new Date(diag.data.ranAt).toLocaleTimeString()}`
              : "Running checks…"
          }
        >
          {diag.data ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <SettingsBadge tone="ok">{okCount} ok</SettingsBadge>
              {noteCount > 0 ? <SettingsBadge>{noteCount} notes</SettingsBadge> : null}
              {fixCount > 0 ? <SettingsBadge tone="error">{fixCount} to fix</SettingsBadge> : null}
            </div>
          ) : (
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          )}
        </SettingsRow>

        {repairNotice ? (
          <div
            className={cn(
              "flex flex-col gap-2 px-4 py-3 text-meta leading-[1.45] sm:px-5",
              repairNotice.ok ? "bg-positive/[0.08] text-positive" : "bg-surface text-ink-soft",
            )}
          >
            <span>{repairNotice.text}</span>
            {repairNotice.command ? <CopyLine value={repairNotice.command} command /> : null}
          </div>
        ) : null}

        {pairAgain ? (
          <div className="px-4 py-3 sm:px-5">
            <PairAgain then="Then click Fix again." />
          </div>
        ) : null}

        {diag.isError ? (
          <div className="px-4 py-4 text-meta text-destructive sm:px-5">
            Could not run diagnostics. Try again or run <code>auni doctor</code> in your terminal.
          </div>
        ) : (
          <div className="divide-y divide-foreground/[0.05]">
            {findings.map((finding, idx) => (
              <div
                key={`${finding.check}-${idx}`}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4 sm:px-5"
              >
                <div className="flex min-w-0 flex-1 items-start gap-2.5">
                  {finding.status === "ok" ? (
                    <CheckCircle2 className="mt-0.5 size-4 flex-none text-positive" />
                  ) : finding.status === "note" ? (
                    <Info className="mt-0.5 size-4 flex-none text-faint" />
                  ) : (
                    <Wrench className="mt-0.5 size-4 flex-none text-destructive" />
                  )}
                  <div className="min-w-0 flex-1">
                    <span className="mr-2 font-mono text-caption font-medium tracking-wide text-faint uppercase">
                      {finding.check}
                    </span>
                    <span className="text-meta leading-[1.45] text-ink-soft">{finding.says}</span>
                  </div>
                </div>
                {finding.repair ? (
                  <button
                    type="button"
                    disabled={repairingId !== null}
                    onClick={() => void runFix(finding.repair!.id)}
                    title={finding.repair.does}
                    className={cn(
                      finding.repair.recommended ? SETTINGS_PRIMARY_BUTTON : SETTINGS_BUTTON,
                      "flex-none",
                    )}
                  >
                    {repairingId === finding.repair.id ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : (
                      <Wrench className="size-3.5" />
                    )}
                    Fix
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </SettingsSection>

      {/* Collapsible recent logs */}
      <details
        id="setting-logs"
        open={logsOpen}
        onToggle={(event) => setLogsOpen((event.currentTarget as HTMLDetailsElement).open)}
        className={cn(
          "group scroll-mt-4 rounded-card border bg-card",
          highlightedTarget === "setting-logs"
            ? "border-primary/50 ring-[3px] ring-ring/25"
            : "border-foreground/[0.08]",
        )}
      >
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 select-none sm:px-5">
          <div className="flex items-center gap-2.5">
            <FileText className="size-4 text-muted-foreground" />
            <div>
              <span className="block text-body font-semibold tracking-[-0.015em] text-ink">
                Recent logs
              </span>
              <span className="mt-0.5 block text-meta text-muted-foreground">
                Last 200 lines of Auni&apos;s log file, redacted of tokens and keys.
              </span>
            </div>
          </div>
          <ChevronDown className="size-4 flex-none text-faint transition-transform group-open:rotate-180" />
        </summary>
        <div className="border-t border-foreground/[0.06] p-4 sm:p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <code className="truncate font-mono text-caption text-faint">
              {logs.data?.path ?? "~/.auni/auni.log"}
            </code>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={logs.isFetching}
                onClick={() => void logs.refetch()}
                className={SETTINGS_BUTTON}
              >
                <RefreshCw className={cn("size-3.5", logs.isFetching && "animate-spin")} />
                Refresh
              </button>
              <button
                type="button"
                disabled={!logs.data?.lines.length}
                onClick={() => {
                  if (!logs.data) return;
                  void navigator.clipboard.writeText(logs.data.lines.join("\n"));
                  setCopiedLogs(true);
                  window.setTimeout(() => setCopiedLogs(false), 1800);
                }}
                className={SETTINGS_BUTTON}
              >
                {copiedLogs ? (
                  <>
                    <Check className="size-3.5 text-positive" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="size-3.5" />
                    Copy
                  </>
                )}
              </button>
            </div>
          </div>
          {logs.isPending ? (
            <div className="flex items-center gap-2 py-6 text-meta text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Loading logs…
            </div>
          ) : !logs.data || logs.data.lines.length === 0 ? (
            <p className="rounded-control bg-surface px-3.5 py-4 text-meta text-muted-foreground">
              No log entries yet at this path.
            </p>
          ) : (
            <pre className="max-h-[260px] overflow-auto rounded-control bg-surface p-3 font-mono text-caption leading-[1.55] whitespace-pre-wrap break-all text-ink-soft">
              {logs.data.lines.join("\n")}
            </pre>
          )}
        </div>
      </details>

      {/* Backup, triage & GitHub */}
      <SettingsSection
        id="setting-backup"
        highlighted={highlightedTarget === "setting-backup"}
        title="Troubleshooting & backups"
        description="Run these on the computer where Auni runs to debug with your own AI or back up your data."
      >
        <SettingsRow
          label="AI-assisted triage"
          description="Your own AI CLI reads Auni's logs and code (never your keys), explains what's wrong, and can draft a GitHub issue."
          stacked
        >
          <CopyLine value="auni triage" command />
        </SettingsRow>
        <SettingsRow
          label="Export & import backups"
          description="Back up or restore your database, routines, and settings."
          stacked
        >
          <div className="flex flex-col gap-2">
            <CopyLine value="auni export" command />
            <CopyLine value="auni import <backup-file>" command />
          </div>
        </SettingsRow>
        <SettingsRow
          label="Report a bug"
          description="Open a GitHub issue with steps to reproduce and any redacted log lines."
        >
          <a href={GITHUB_ISSUES} target="_blank" rel="noreferrer" className={SETTINGS_BUTTON}>
            Open GitHub Issues
            <ArrowUpRight className="size-3.5" />
          </a>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
