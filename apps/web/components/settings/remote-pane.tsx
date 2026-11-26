"use client";

import type { RemoteAccessWire } from "@auni/shared";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  ChevronDown,
  Copy,
  GlobeLock,
  Laptop,
  Link2,
  LoaderCircle,
  Power,
  QrCode,
  RefreshCw,
  Server,
  Smartphone,
  Trash2,
} from "lucide-react";
import { useState } from "react";

import { PairAgain } from "@/components/auth/pair-again";
import { CopyLine } from "@/components/ui/copy-line";
import { QrCodeCanvas } from "@/components/ui/qr-code";
import { CoreApiError } from "@/lib/core";
import {
  useDisableTailscale,
  useEnableTailscale,
  useInstallService,
  useMintPairingLink,
  useRemoteAccess,
  useRevokeOtherSessions,
  useRevokeSession,
  useUninstallService,
} from "@/lib/data/system";
import { cn } from "@/lib/utils";

import { KeepRunning } from "./always-on-pane";
import {
  SETTINGS_BUTTON,
  SETTINGS_PRIMARY_BUTTON,
  SettingsBadge,
  SettingsRow,
  SettingsSection,
} from "./settings-layout";

const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";
const TAILSCALE_DNS_ADMIN = "https://login.tailscale.com/admin/dns";
const PORT_PRESETS = [443, 8443, 9443] as const;

function parseAgent(ua: string | null): { readonly title: string; readonly mobile: boolean } {
  if (!ua) return { title: "Browser session", mobile: false };
  const mobile = /iphone|ipad|android|mobile/iu.test(ua);
  const browser = /edg\//iu.test(ua)
    ? "Edge"
    : /firefox\//iu.test(ua)
      ? "Firefox"
      : /chrome\//iu.test(ua)
        ? "Chrome"
        : /safari\//iu.test(ua)
          ? "Safari"
          : "Browser";
  const os = /iphone|ipad/iu.test(ua)
    ? "iOS"
    : /android/iu.test(ua)
      ? "Android"
      : /mac os x|macintosh/iu.test(ua)
        ? "macOS"
        : /windows/iu.test(ua)
          ? "Windows"
          : /linux/iu.test(ua)
            ? "Linux"
            : null;
  return { title: os ? `${browser} on ${os}` : browser, mobile };
}

function relativeTime(iso: string | null): string {
  if (!iso) return "Unknown";
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function isPairAgain(error: unknown): boolean {
  return error instanceof CoreApiError && error.code === "pair_again";
}

function errDetail(error: unknown, fallback: string): string {
  if (error instanceof CoreApiError && error.detail) return error.detail;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function RemotePane({ highlightedTarget }: { readonly highlightedTarget: string | null }) {
  const remote = useRemoteAccess(true);
  const enableTs = useEnableTailscale();
  const disableTs = useDisableTailscale();
  const installSvc = useInstallService();
  const uninstallSvc = useUninstallService();
  const mintPair = useMintPairingLink();
  const revokeOne = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();

  const [port, setPort] = useState<number>(443);
  const [showQr, setShowQr] = useState(true);
  const [tsCommand, setTsCommand] = useState<string | null>(null);
  const [tsRestartCommand, setTsRestartCommand] = useState<string | null>(null);
  const [tsRestartNote, setTsRestartNote] = useState<string | null>(null);
  const [tsError, setTsError] = useState<string | null>(null);
  const [pairAgainFor, setPairAgainFor] = useState<string | null>(null);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);

  if (remote.isPending && !remote.data) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-card border border-foreground/[0.08] bg-card py-12 text-meta text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        Inspecting Tailscale, service, and sessions…
      </div>
    );
  }

  if (remote.isError || !remote.data) {
    return (
      <div className="rounded-card border border-foreground/[0.08] bg-card p-5 text-meta text-destructive">
        Could not load remote access status. Try reopening Settings.
      </div>
    );
  }

  const data: RemoteAccessWire = remote.data;
  const ts = data.tailscale;
  const tailscaleActive = ts.configured || ts.served;
  const liveRemoteUrl = ts.url ?? (data.mode === "tailscale" ? data.address : null);
  const previewUrl = ts.dnsName ? `https://${ts.dnsName}${port === 443 ? "" : `:${port}`}` : null;

  const copyOrigin = (value: string) => {
    void navigator.clipboard.writeText(value);
    setCopiedUrl(true);
    window.setTimeout(() => setCopiedUrl(false), 1800);
  };

  const restartCmd =
    data.service.runningAs === "service" || data.service.installed
      ? "auni stop && auni service install"
      : "auni stop && auni";

  const handleEnableTs = async () => {
    setTsError(null);
    setTsCommand(null);
    setTsRestartNote(null);
    setTsRestartCommand(null);
    setPairAgainFor(null);
    try {
      const result = await enableTs.mutateAsync({ port });
      if (!result.ok) {
        if (result.sudoCommand) setTsCommand(result.sudoCommand);
        const fixStep = result.steps.find((s) => s.status === "fix");
        setTsError(fixStep?.says ?? "Tailscale Serve could not be enabled automatically.");
        return;
      }
      if (result.needsRestart) {
        setTsRestartNote(
          "Tailscale HTTPS is saved and Serve is active. Restart Auni so it starts listening on the private Tailscale door:",
        );
        setTsRestartCommand(restartCmd);
      }
    } catch (error) {
      if (isPairAgain(error)) setPairAgainFor("tailscale");
      else setTsError(errDetail(error, "Could not enable Tailscale HTTPS."));
    }
  };

  const handleDisableTs = async () => {
    setTsError(null);
    setTsCommand(null);
    setTsRestartNote(null);
    setTsRestartCommand(null);
    setPairAgainFor(null);
    try {
      const result = await disableTs.mutateAsync();
      setTsRestartNote(
        result.note ?? "Tailscale HTTPS disabled. Restart Auni to return to local pairing mode:",
      );
      setTsRestartCommand(
        result.serveOffCommand ? `${result.serveOffCommand} && ${restartCmd}` : restartCmd,
      );
    } catch (error) {
      if (isPairAgain(error)) setPairAgainFor("tailscale");
      else setTsError(errDetail(error, "Could not disable Tailscale HTTPS."));
    }
  };

  const handleToggleService = async () => {
    setServiceError(null);
    setPairAgainFor(null);
    try {
      if (data.service.installed) await uninstallSvc.mutateAsync();
      else await installSvc.mutateAsync();
    } catch (error) {
      if (isPairAgain(error)) setPairAgainFor("service");
      else setServiceError(errDetail(error, "Could not update the background service."));
    }
  };

  const handleMintPair = async () => {
    setPairAgainFor(null);
    try {
      await mintPair.mutateAsync({});
    } catch (error) {
      if (isPairAgain(error)) setPairAgainFor("sessions");
    }
  };

  const handleRevoke = async (id: string) => {
    setPairAgainFor(null);
    try {
      await revokeOne.mutateAsync(id);
    } catch (error) {
      if (isPairAgain(error)) setPairAgainFor("sessions");
    }
  };

  const handleRevokeOthers = async () => {
    setPairAgainFor(null);
    try {
      await revokeOthers.mutateAsync();
    } catch (error) {
      if (isPairAgain(error)) setPairAgainFor("sessions");
    }
  };

  const otherSessionCount = data.sessions.filter((s) => !s.current).length;

  return (
    <div className="flex flex-col gap-5">
      {/* Current machine summary */}
      <SettingsSection
        title="This machine"
        description="Where Auni is running right now and how your browser reaches it."
        action={
          <SettingsBadge tone={data.mode === "tailscale" ? "ok" : "neutral"}>
            {data.mode === "tailscale" ? "Tailscale HTTPS" : "Local only"}
          </SettingsBadge>
        }
      >
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              <Server className="size-4 text-muted-foreground" />
              <span>{data.machine}</span>
            </span>
          }
          description={
            data.mode === "tailscale" && ts.login
              ? `Tailscale owner: ${ts.login}`
              : "Listening on loopback (127.0.0.1), paired browsers only."
          }
        >
          <div className="flex items-center gap-2">
            <code className="max-w-[240px] truncate rounded-control bg-surface px-2.5 py-1 font-mono text-caption text-ink">
              {data.address}
            </code>
            <button
              type="button"
              onClick={() => copyOrigin(data.address)}
              className={SETTINGS_BUTTON}
            >
              {copiedUrl ? (
                <Check className="size-3.5 text-positive" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {copiedUrl ? "Copied" : "Copy"}
            </button>
          </div>
        </SettingsRow>
      </SettingsSection>

      {/* Tailscale HTTPS */}
      <SettingsSection
        id="setting-tailscale"
        highlighted={highlightedTarget === "setting-tailscale"}
        title="Tailscale HTTPS"
        description="Expose Auni privately to your own phone and laptop over WireGuard and HTTPS, with zero public ports, no passwords, and identity verified by your tailnet."
        action={
          <button
            type="button"
            disabled={remote.isFetching}
            onClick={() => void remote.refetch()}
            className={SETTINGS_BUTTON}
          >
            <RefreshCw className={cn("size-3.5", remote.isFetching && "animate-spin")} />
            Re-check
          </button>
        }
      >
        {ts.state === "missing" ? (
          <SettingsRow
            label="Tailscale is not installed on this machine"
            description="Install Tailscale (free for personal use) on this computer and your phone, signed into the same account."
          >
            <a
              href={TAILSCALE_DOWNLOAD}
              target="_blank"
              rel="noreferrer"
              className={SETTINGS_PRIMARY_BUTTON}
            >
              Get Tailscale
              <ArrowUpRight className="size-3.5" />
            </a>
          </SettingsRow>
        ) : ts.state === "stopped" ? (
          <SettingsRow
            label="Tailscale is installed, but not connected"
            description={ts.problem ?? "Sign in to Tailscale on this machine, then click Re-check."}
            stacked
          >
            <CopyLine value="tailscale up" command />
          </SettingsRow>
        ) : ts.state === "tagged" ? (
          <SettingsRow
            label="This machine uses a Tailscale tag"
            description={
              ts.problem ??
              "Tagged nodes have no personal login identity. Re-authenticate with your own Tailscale account (`tailscale up --reset`) so Auni knows it is you."
            }
          />
        ) : ts.state === "https_off" ? (
          <SettingsRow
            label={`Enable HTTPS certificates on ${ts.dnsName ?? "your tailnet"}`}
            description={
              ts.problem ??
              "In your Tailscale admin console, enable MagicDNS and HTTPS Certificates, then click Re-check."
            }
          >
            <a
              href={TAILSCALE_DNS_ADMIN}
              target="_blank"
              rel="noreferrer"
              className={SETTINGS_PRIMARY_BUTTON}
            >
              Open Tailscale DNS
              <ArrowUpRight className="size-3.5" />
            </a>
          </SettingsRow>
        ) : tailscaleActive && liveRemoteUrl ? (
          <SettingsRow
            label={
              <span className="flex items-center gap-2">
                <GlobeLock className="size-4 text-positive" />
                <span>Reachable over Tailscale</span>
                <SettingsBadge tone="ok">{ts.served ? "Active" : "Configured"}</SettingsBadge>
              </span>
            }
            description={`Signed in as ${ts.login ?? "your Tailscale account"}. Any device on your tailnet opens this URL directly, with no pairing code needed.`}
            stacked
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                <CopyLine value={liveRemoteUrl} />
                <div className="flex flex-wrap items-center gap-2">
                  <a
                    href={liveRemoteUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={SETTINGS_PRIMARY_BUTTON}
                  >
                    Open URL
                    <ArrowUpRight className="size-3.5" />
                  </a>
                  <button
                    type="button"
                    onClick={() => setShowQr((prev) => !prev)}
                    className={SETTINGS_BUTTON}
                  >
                    <QrCode className="size-3.5" />
                    {showQr ? "Hide phone QR" : "Show phone QR"}
                  </button>
                  <button
                    type="button"
                    disabled={disableTs.isPending}
                    onClick={() => void handleDisableTs()}
                    className={cn(SETTINGS_BUTTON, "text-destructive")}
                  >
                    {disableTs.isPending ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : null}
                    Disable
                  </button>
                </div>
              </div>
              {showQr ? (
                <div className="flex flex-col items-center gap-1.5">
                  <QrCodeCanvas
                    value={liveRemoteUrl}
                    label={`QR code to open Auni at ${liveRemoteUrl}`}
                    size={136}
                  />
                  <span className="text-caption text-muted-foreground">Scan on your phone</span>
                </div>
              ) : null}
            </div>
          </SettingsRow>
        ) : (
          <SettingsRow
            label={`Ready on ${ts.dnsName ?? "this machine"}`}
            description={`Signed in as ${ts.login ?? "your account"}. Choose an HTTPS port and enable Tailscale Serve to reach Auni from your phone.`}
            stacked
          >
            <div className="flex flex-wrap items-center gap-2.5">
              <div className="flex items-center gap-1.5 rounded-control bg-surface p-1">
                {PORT_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setPort(preset)}
                    className={cn(
                      "rounded-control px-2.5 py-1 font-mono text-caption transition-colors",
                      port === preset
                        ? "bg-card font-medium text-ink ring-1 ring-border"
                        : "text-muted-foreground hover:text-ink",
                    )}
                  >
                    {preset === 443 ? "443 (default)" : preset}
                  </button>
                ))}
              </div>
              <button
                type="button"
                disabled={enableTs.isPending}
                onClick={() => void handleEnableTs()}
                className={SETTINGS_PRIMARY_BUTTON}
              >
                {enableTs.isPending ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <GlobeLock className="size-3.5" />
                )}
                Enable Tailscale HTTPS
              </button>
            </div>
            {previewUrl ? (
              <p className="text-caption text-muted-foreground">
                Will publish at <code className="font-mono text-ink">{previewUrl}</code>
              </p>
            ) : null}
          </SettingsRow>
        )}

        {tsCommand ? (
          <SettingsRow
            label="One-time root permission needed"
            description="Run this once in your terminal so Tailscale Serve can forward HTTPS traffic to Auni, then click Verify & save below. Nothing has been saved yet, so your current local access stays intact."
            stacked
          >
            <CopyLine value={tsCommand} command />
            <div>
              <button
                type="button"
                disabled={enableTs.isPending}
                onClick={() => void handleEnableTs()}
                className={SETTINGS_PRIMARY_BUTTON}
              >
                {enableTs.isPending ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                I ran it, verify &amp; save
              </button>
            </div>
          </SettingsRow>
        ) : null}
        {tsRestartNote ? (
          <div className="flex flex-col gap-2 bg-positive/[0.08] px-4 py-3 text-meta leading-[1.45] text-positive sm:px-5">
            <span>{tsRestartNote}</span>
            {tsRestartCommand ? <CopyLine value={tsRestartCommand} command /> : null}
          </div>
        ) : null}
        {tsError ? (
          <div className="px-4 py-3 text-meta text-destructive sm:px-5">{tsError}</div>
        ) : null}
        {pairAgainFor === "tailscale" ? (
          <div className="px-4 py-3 sm:px-5">
            <PairAgain then="Then try updating Tailscale HTTPS again." />
          </div>
        ) : null}
      </SettingsSection>

      {/* Background service (Always on) */}
      <SettingsSection
        id="setting-service"
        highlighted={highlightedTarget === "setting-service"}
        title="Background service (Always on)"
        description="Keep Auni running automatically in the background across reboots and closed terminals."
        action={
          <SettingsBadge tone={data.service.staysOn.stays ? "ok" : "neutral"}>
            {data.service.staysOn.stays ? "Always on" : "Manual"}
          </SettingsBadge>
        }
      >
        {data.service.supported &&
        !data.service.installed &&
        data.service.runningAs &&
        data.service.runningAs !== "service" ? (
          <SettingsRow
            label="Hand off to the background service"
            description="Auni is currently running from a terminal or background process. Run this in a terminal so it stops cleanly and the OS service takes over:"
            stacked
          >
            <CopyLine value="auni stop && auni service install" command />
          </SettingsRow>
        ) : data.service.supported &&
          data.service.installed &&
          data.service.runningAs === "service" ? (
          <SettingsRow
            label="User service active"
            description="Auni is currently running inside the OS background service. To stop and remove it cleanly, run this in a terminal:"
            stacked
          >
            <CopyLine value="auni service uninstall" command />
          </SettingsRow>
        ) : (
          <SettingsRow
            label={data.service.installed ? "User service installed" : "Run as background service"}
            description={data.service.staysOn.says}
          >
            {data.service.supported ? (
              <button
                type="button"
                disabled={installSvc.isPending || uninstallSvc.isPending}
                onClick={() => void handleToggleService()}
                className={data.service.installed ? SETTINGS_BUTTON : SETTINGS_PRIMARY_BUTTON}
              >
                {installSvc.isPending || uninstallSvc.isPending ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <Power className="size-3.5" />
                )}
                {data.service.installed ? "Remove service" : "Install service"}
              </button>
            ) : (
              <SettingsBadge tone="neutral">Unsupported OS</SettingsBadge>
            )}
          </SettingsRow>
        )}

        {data.service.lingers === false && data.service.lingerCommand ? (
          <SettingsRow
            label="Keep running after logout (Linux linger)"
            description="Without linger, systemd stops user services when you close SSH or log out. Run this once:"
            stacked
          >
            <CopyLine value={data.service.lingerCommand} command />
          </SettingsRow>
        ) : null}
        {serviceError ? (
          <div className="px-4 py-3 text-meta text-destructive sm:px-5">{serviceError}</div>
        ) : null}
        {pairAgainFor === "service" ? (
          <div className="px-4 py-3 sm:px-5">
            <PairAgain then="Then toggle the background service again." />
          </div>
        ) : null}
      </SettingsSection>

      {/* Paired devices & browsers (local pairing mode) */}
      {data.mode === "local" ? (
        <SettingsSection
          id="setting-sessions"
          highlighted={highlightedTarget === "setting-sessions"}
          title="Paired devices & browsers"
          description="Create a one-time 15-minute pairing link or revoke browsers that currently hold an owner session."
          action={
            <button
              type="button"
              disabled={mintPair.isPending}
              onClick={() => void handleMintPair()}
              className={SETTINGS_PRIMARY_BUTTON}
            >
              {mintPair.isPending ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <Link2 className="size-3.5" />
              )}
              Create pairing link
            </button>
          }
        >
          {mintPair.data ? (
            <SettingsRow
              label="One-time pairing link"
              description={`Valid once until ${new Date(mintPair.data.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Anyone who opens it becomes the owner in that browser.`}
              stacked
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                  <CopyLine value={mintPair.data.url} />
                  {mintPair.data.loopback ? (
                    <div className="flex items-start gap-2 rounded-control bg-surface px-3 py-2 text-caption leading-[1.45] text-ink-soft">
                      <AlertTriangle className="mt-0.5 size-3.5 flex-none" />
                      <span>
                        This link uses <code>localhost</code> and only works on this computer.
                        Enable Tailscale HTTPS above to open Auni from a phone or another device.
                      </span>
                    </div>
                  ) : null}
                </div>
                {!mintPair.data.loopback ? (
                  <QrCodeCanvas
                    value={mintPair.data.url}
                    label="QR code for one-time pairing link"
                    size={132}
                  />
                ) : null}
              </div>
            </SettingsRow>
          ) : null}

          {data.sessions.length > 0 ? (
            <>
              {data.sessions.map((session) => {
                const parsed = parseAgent(session.userAgent);
                return (
                  <SettingsRow
                    key={session.id}
                    label={
                      <span className="flex items-center gap-2">
                        {parsed.mobile ? (
                          <Smartphone className="size-4 text-muted-foreground" />
                        ) : (
                          <Laptop className="size-4 text-muted-foreground" />
                        )}
                        <span>{session.label || parsed.title}</span>
                        {session.current ? (
                          <SettingsBadge tone="accent">This device</SettingsBadge>
                        ) : null}
                      </span>
                    }
                    description={`Last active ${relativeTime(session.lastSeenAt ?? session.createdAt)}, paired ${new Date(session.createdAt).toLocaleDateString()}`}
                  >
                    {!session.current ? (
                      <button
                        type="button"
                        disabled={revokeOne.isPending}
                        onClick={() => void handleRevoke(session.id)}
                        className={cn(SETTINGS_BUTTON, "text-destructive")}
                      >
                        <Trash2 className="size-3.5" />
                        Revoke
                      </button>
                    ) : null}
                  </SettingsRow>
                );
              })}
              {otherSessionCount > 0 ? (
                <SettingsRow
                  label="Sign out other browsers"
                  description={`Immediately revoke ${otherSessionCount} other paired browser ${otherSessionCount === 1 ? "session" : "sessions"}.`}
                >
                  <button
                    type="button"
                    disabled={revokeOthers.isPending}
                    onClick={() => void handleRevokeOthers()}
                    className={cn(SETTINGS_BUTTON, "text-destructive")}
                  >
                    {revokeOthers.isPending ? (
                      <LoaderCircle className="size-3.5 animate-spin" />
                    ) : null}
                    Revoke others ({otherSessionCount})
                  </button>
                </SettingsRow>
              ) : null}
            </>
          ) : (
            <div className="px-4 py-3.5 text-meta text-muted-foreground sm:px-5">
              No active paired browser sessions found.
            </div>
          )}

          {pairAgainFor === "sessions" ? (
            <div className="px-4 py-3 sm:px-5">
              <PairAgain then="Then retry that session action." />
            </div>
          ) : null}
        </SettingsSection>
      ) : null}

      {/* Move to another machine (Handover) */}
      {data.mode === "local" ? (
        <details
          id="setting-handover"
          className={cn(
            "group scroll-mt-4 rounded-card border bg-card",
            highlightedTarget === "setting-handover"
              ? "border-primary/50 ring-[3px] ring-ring/25"
              : "border-foreground/[0.08]",
          )}
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 select-none sm:px-5">
            <div>
              <span className="block text-body font-semibold tracking-[-0.015em] text-ink">
                Move Auni to another machine
              </span>
              <span className="mt-0.5 block text-meta text-muted-foreground">
                Hand over your wallet keys, database, and settings once to an always-on Linux or Mac
                machine on Tailscale.
              </span>
            </div>
            <ChevronDown className="size-4 flex-none text-faint transition-transform group-open:rotate-180" />
          </summary>
          <div className="border-t border-foreground/[0.06] px-4 pb-5 sm:px-5">
            <KeepRunning />
          </div>
        </details>
      ) : null}
    </div>
  );
}
