"use client";

import type { AppWire, RemoteAccessWire } from "@auni/shared";
import { ArrowUpRight, Laptop, LoaderCircle, Smartphone } from "lucide-react";
import { useState } from "react";

import { AppKeysNeeded, AppSettings } from "@/components/apps/app-keys";
import { AppMark } from "@/components/apps/app-mark";
import { AppPairing } from "@/components/apps/app-pairing";
import { AppSwitch } from "@/components/apps/app-switch";
import { useStartConversation } from "@/components/app/use-start-conversation";
import { mustPairAgain, PairAgain } from "@/components/auth/pair-again";
import { Badge } from "@/components/ui/badge";
import { CopyLine } from "@/components/ui/copy-line";
import { QrCodeCanvas } from "@/components/ui/qr-code";
import { CoreApiError } from "@/lib/core";
import { useApps } from "@/lib/data/apps";
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
import { browserName, lastSeen } from "./sessions";
import {
  Disclosure,
  Refusal,
  Setting,
  SETTINGS_BUTTON,
  SETTINGS_PRIMARY_BUTTON,
  SettingsGroup,
} from "./settings-layout";

const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";
const TAILSCALE_DNS = "https://login.tailscale.com/admin/dns";
const PORTS = [443, 8443, 9443] as const;

/** Core's own words when it turns something down, else ours. */
const said = (error: unknown, otherwise: string) =>
  error instanceof CoreApiError && error.detail ? error.detail : otherwise;

/**
 * Your devices: where Auni runs and how the owner reaches it, as a small scene (this computer,
 * and their phone, joined once Tailscale joins them); then each way to reach it further: the
 * phone, Telegram, keeping it running, the browsers signed in, and moving it to a computer that
 * stays on.
 */
export function DevicesPane() {
  const remote = useRemoteAccess(true);
  if (!remote.data)
    return remote.isError ? (
      <Refusal>
        Couldn&apos;t load your device settings. Close Settings and open it again.
      </Refusal>
    ) : (
      <div className="flex items-center justify-center gap-2 py-16 text-meta text-muted-foreground">
        <LoaderCircle aria-hidden className="size-4 animate-spin" />
        Checking this computer
      </div>
    );
  const data = remote.data;
  return (
    <>
      <Scene data={data} />
      <Phone data={data} recheck={() => void remote.refetch()} checking={remote.isFetching} />
      <Telegram />
      <Running data={data} />
      {data.mode === "local" ? <Browsers data={data} /> : null}
      {data.mode === "local" ? (
        <Disclosure
          id="setting-handover"
          title="Move Auni to another computer"
          hint="One that stays on"
        >
          <KeepRunning />
        </Disclosure>
      ) : null}
    </>
  );
}

/** This computer and the owner's phone, and whether anything joins them yet. */
function Scene({ data }: { readonly data: RemoteAccessWire }) {
  const reached = data.mode === "tailscale";
  return (
    <figure className="flex flex-col items-center gap-4 rounded-card border border-border bg-card px-4 py-6">
      <div className="flex w-full max-w-[360px] items-center">
        <Device icon={<Laptop strokeWidth={1.7} />} name={data.machine} on />
        <span
          aria-hidden
          className={cn(
            "mx-3 mb-6 h-px flex-1",
            reached ? "bg-ink/40" : "border-t border-dashed border-border bg-transparent",
          )}
        />
        <Device icon={<Smartphone strokeWidth={1.7} />} name="Your phone" on={reached} />
      </div>
      <figcaption className="max-w-[400px] text-center text-meta leading-[1.5] text-muted-foreground">
        {reached
          ? `Auni runs on ${data.machine}. Open it from any of your devices on Tailscale.`
          : `Auni runs on ${data.machine}. Reachable only on this computer for now.`}
      </figcaption>
    </figure>
  );
}

function Device({
  icon,
  name,
  on,
}: {
  readonly icon: React.ReactNode;
  readonly name: string;
  readonly on: boolean;
}) {
  return (
    <span className="flex w-24 flex-none flex-col items-center gap-2">
      <span
        className={cn(
          "flex size-12 items-center justify-center rounded-card border [&_svg]:size-6",
          on ? "border-border bg-surface text-ink" : "border-dashed border-border text-faint",
        )}
      >
        {icon}
      </span>
      <span
        className={cn("max-w-full truncate text-meta", on ? "text-ink" : "text-muted-foreground")}
      >
        {name}
      </span>
    </span>
  );
}

/**
 * Reaching Auni from the owner's phone, through Tailscale: each step it still needs said as the
 * one thing to do now, and once it works, where to open it and its code for a phone's camera.
 */
function Phone({
  data,
  recheck,
  checking,
}: {
  readonly data: RemoteAccessWire;
  readonly recheck: () => void;
  readonly checking: boolean;
}) {
  const enable = useEnableTailscale();
  const disable = useDisableTailscale();
  const [port, setPort] = useState<number>(443);
  const [command, setCommand] = useState<string | null>(null);
  const [restart, setRestart] = useState<{ says: string; command: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairAgain, setPairAgain] = useState(false);
  const ts = data.tailscale;
  const url = ts.url ?? (data.mode === "tailscale" ? data.address : null);
  const live = ts.configured || ts.served;
  const restartAuni =
    data.service.runningAs === "service" || data.service.installed
      ? "auni stop && auni service install"
      : "auni stop && auni";

  const start = () => {
    setError(null);
    setCommand(null);
    setRestart(null);
    setPairAgain(false);
  };
  const turnOn = async () => {
    start();
    try {
      const result = await enable.mutateAsync({ port });
      if (!result.ok) {
        if (result.sudoCommand) setCommand(result.sudoCommand);
        else
          setError(
            result.steps.find((step) => step.status === "fix")?.says ??
              "Tailscale didn't accept the change. Check again in a moment.",
          );
      } else if (result.needsRestart)
        setRestart({
          says: "Done. Restart Auni in your terminal so your phone can reach it:",
          command: restartAuni,
        });
    } catch (caught) {
      if (mustPairAgain(caught)) setPairAgain(true);
      else setError(said(caught, "That didn't reach Auni, so nothing changed. Try again."));
    }
  };
  const turnOff = async () => {
    start();
    try {
      const result = await disable.mutateAsync();
      setRestart({
        says: "Restart Auni in your terminal to finish. After that, it's reachable only on this computer.",
        command: result.serveOffCommand
          ? `${result.serveOffCommand} && ${restartAuni}`
          : restartAuni,
      });
    } catch (caught) {
      if (mustPairAgain(caught)) setPairAgain(true);
      else setError(said(caught, "That didn't reach Auni, so nothing changed. Try again."));
    }
  };

  const checkAgain = (
    <button type="button" disabled={checking} onClick={recheck} className={SETTINGS_BUTTON}>
      {checking ? <LoaderCircle aria-hidden className="size-3.5 animate-spin" /> : null}
      Check again
    </button>
  );

  return (
    <SettingsGroup id="setting-phone" title="Use Auni on your phone">
      {live && url ? (
        <Setting
          label="Open Auni on any of your devices"
          hint={`Signed in to Tailscale as ${ts.login ?? "you"}. No pairing needed.`}
          stacked
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <QrCodeCanvas
              value={url}
              label="QR code to open Auni on your phone"
              size={128}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2.5">
              <CopyLine value={url} />
              <div className="flex flex-wrap gap-2">
                <a href={url} target="_blank" rel="noreferrer" className={SETTINGS_PRIMARY_BUTTON}>
                  Open
                  <ArrowUpRight aria-hidden className="size-3.5" />
                </a>
                <button
                  type="button"
                  disabled={disable.isPending}
                  onClick={() => void turnOff()}
                  className={SETTINGS_BUTTON}
                >
                  Turn off
                </button>
              </div>
            </div>
          </div>
        </Setting>
      ) : ts.state === "missing" ? (
        <Setting
          label="Get Tailscale on this computer and your phone"
          hint="It's free, and joins your devices privately. Sign in to the same account on both."
        >
          <a
            href={TAILSCALE_DOWNLOAD}
            target="_blank"
            rel="noreferrer"
            className={SETTINGS_PRIMARY_BUTTON}
          >
            Get Tailscale
            <ArrowUpRight aria-hidden className="size-3.5" />
          </a>
        </Setting>
      ) : ts.state === "stopped" ? (
        <Setting
          label="Sign in to Tailscale on this computer"
          hint="Open Tailscale and sign in, then check again."
        >
          {checkAgain}
        </Setting>
      ) : ts.state === "tagged" ? (
        <Setting
          label="Sign in to Tailscale as yourself"
          hint={
            ts.problem ?? "This computer joined Tailscale with a tag, so Auni can't tell it's you."
          }
        >
          {checkAgain}
        </Setting>
      ) : ts.state === "https_off" ? (
        <Setting
          label="Turn on HTTPS in Tailscale"
          hint="In Tailscale's DNS settings, turn on HTTPS Certificates, then check again."
        >
          <div className="flex gap-2">
            <a href={TAILSCALE_DNS} target="_blank" rel="noreferrer" className={SETTINGS_BUTTON}>
              Open Tailscale
              <ArrowUpRight aria-hidden className="size-3.5" />
            </a>
            {checkAgain}
          </div>
        </Setting>
      ) : (
        <Setting
          label="Turn on phone access"
          hint={`Tailscale is ready on ${data.machine}. Turn this on to open Auni from your phone.`}
        >
          <button
            type="button"
            disabled={enable.isPending}
            onClick={() => void turnOn()}
            className={SETTINGS_PRIMARY_BUTTON}
          >
            {enable.isPending ? (
              <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
            ) : null}
            Turn on
          </button>
        </Setting>
      )}
      {command ? (
        <Setting
          label="Run this once in your terminal"
          hint="Tailscale needs your permission to pass your phone through to Auni. Nothing has changed yet."
          stacked
        >
          <CopyLine value={command} command />
          <button
            type="button"
            disabled={enable.isPending}
            onClick={() => void turnOn()}
            className={cn(SETTINGS_PRIMARY_BUTTON, "mt-2.5")}
          >
            I ran it
          </button>
        </Setting>
      ) : null}
      {restart ? (
        <Setting label={restart.says} stacked>
          <CopyLine value={restart.command} command />
        </Setting>
      ) : null}
      {error || pairAgain ? (
        <div className="px-4 py-3 sm:px-5">
          {pairAgain ? <PairAgain then="Then try again." /> : <Refusal>{error}</Refusal>}
        </div>
      ) : null}
      {!live && ts.state !== "missing" ? (
        <div className="px-4 py-3 sm:px-5">
          <Disclosure id="setting-phone-details" title="Details">
            <div className="flex flex-col gap-3 text-meta leading-[1.5] text-muted-foreground">
              {ts.problem ? <p>{ts.problem}</p> : null}
              {ts.state === "stopped" ? <CopyLine value="tailscale up" command /> : null}
              {ts.state === "ready" ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span>HTTPS port</span>
                  {PORTS.map((each) => (
                    <button
                      key={each}
                      type="button"
                      aria-pressed={port === each}
                      onClick={() => setPort(each)}
                      className={cn(
                        "h-7 rounded-control px-2.5 font-mono text-caption tabular-nums",
                        port === each ? "bg-foreground/[0.08] text-ink" : "hover:text-ink",
                      )}
                    >
                      {each}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </Disclosure>
        </div>
      ) : null}
    </SettingsGroup>
  );
}

/** Whether Auni keeps running when the terminal closes or the computer restarts. */
function Running({ data }: { readonly data: RemoteAccessWire }) {
  const install = useInstallService();
  const uninstall = useUninstallService();
  const [error, setError] = useState<string | null>(null);
  const [pairAgain, setPairAgain] = useState(false);
  const { service } = data;
  const busy = install.isPending || uninstall.isPending;

  const toggle = async () => {
    setError(null);
    setPairAgain(false);
    try {
      if (service.installed) await uninstall.mutateAsync();
      else await install.mutateAsync();
    } catch (caught) {
      if (mustPairAgain(caught)) setPairAgain(true);
      else setError(said(caught, "That didn't reach Auni, so nothing changed. Try again."));
    }
  };

  // Started by hand, it hands over to the service from a terminal; run by the service, it can't
  // remove the service it runs in from here.
  const handOff =
    service.supported && !service.installed && service.runningAs && service.runningAs !== "service";
  const inside = service.supported && service.installed && service.runningAs === "service";

  return (
    <SettingsGroup id="setting-running" title="Keep Auni running">
      <Setting
        label={service.staysOn.stays ? "Always on" : "Not always on"}
        hint={
          service.staysOn.stays
            ? "Starts automatically when this computer restarts."
            : service.staysOn.says
        }
        stacked={Boolean(handOff || inside)}
      >
        {handOff ? (
          <>
            <p className="mb-2 text-meta text-muted-foreground">
              To keep it running, run this in your terminal:
            </p>
            <CopyLine value="auni stop && auni service install" command />
          </>
        ) : inside ? (
          <>
            <p className="mb-2 text-meta text-muted-foreground">
              To turn this off, run this in your terminal:
            </p>
            <CopyLine value="auni service uninstall" command />
          </>
        ) : service.supported ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void toggle()}
            className={service.installed ? SETTINGS_BUTTON : SETTINGS_PRIMARY_BUTTON}
          >
            {busy ? <LoaderCircle aria-hidden className="size-3.5 animate-spin" /> : null}
            {service.installed ? "Turn off" : "Keep it running"}
          </button>
        ) : (
          <Badge>Not supported here</Badge>
        )}
      </Setting>
      {service.lingers === false && service.lingerCommand ? (
        <Setting
          label="Keep it running after you log out"
          hint="Run this once in your terminal:"
          stacked
        >
          <CopyLine value={service.lingerCommand} command />
        </Setting>
      ) : null}
      {error || pairAgain ? (
        <div className="px-4 py-3 sm:px-5">
          {pairAgain ? <PairAgain then="Then try again." /> : <Refusal>{error}</Refusal>}
        </div>
      ) : null}
    </SettingsGroup>
  );
}

/** Each chat app Auni can talk in: its key, pairing it with the owner's own chat, its switch. */
function Telegram() {
  const apps = useApps();
  const { busy, start } = useStartConversation();
  const chats = (apps.data?.apps ?? []).filter((app) => app.pairing !== null);
  if (chats.length === 0) return null;
  return (
    <>
      {chats.map((app) => (
        <SettingsGroup key={app.id} id="setting-telegram" title={app.name}>
          <div className="flex flex-col gap-1 px-4 pt-4 pb-5 sm:px-5">
            <div className="flex items-center gap-3">
              <AppMark id={app.id} name={app.name} size={36} />
              <span className="min-w-0 flex-1">
                <span className="block text-ui font-medium text-ink">
                  Talk to Auni on {app.name}
                </span>
                <span className="block text-meta text-muted-foreground">{chatStanding(app)}</span>
              </span>
            </div>
            <AppKeysNeeded app={app} />
            <AppPairing app={app} name={app.name} />
            <AppSettings app={app} settingsFile={apps.data?.settingsFile ?? ""} />
            {app.canSwitch ? (
              <AppSwitch
                app={app}
                name={app.name}
                busy={busy}
                onAsk={(prompt) => void start(prompt)}
              />
            ) : null}
          </div>
        </SettingsGroup>
      ))}
    </>
  );
}

/** How a chat app stands, in a line. */
function chatStanding(app: AppWire): string {
  if (!app.on) return "Off";
  if (app.pairing === "paired") return "Paired with your chat";
  if (app.pairing === "ready") return "Ready to pair with your chat";
  return "Not set up yet";
}

/** The browsers signed in to Auni on this computer, a link to sign in another, and signing out. */
function Browsers({ data }: { readonly data: RemoteAccessWire }) {
  const mint = useMintPairingLink();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const [pairAgain, setPairAgain] = useState(false);
  const others = data.sessions.filter((session) => !session.current).length;

  const guard = async (run: () => Promise<unknown>) => {
    setPairAgain(false);
    try {
      await run();
    } catch (caught) {
      if (mustPairAgain(caught)) setPairAgain(true);
    }
  };

  return (
    <SettingsGroup id="setting-browsers" title="Signed-in browsers">
      {data.sessions.map((session) => (
        <Setting
          key={session.id}
          label={
            <span className="flex items-center gap-2">
              {session.label || browserName(session.userAgent)}
              {session.current ? <Badge>This browser</Badge> : null}
            </span>
          }
          hint={lastSeen(session.lastSeenAt ?? session.createdAt)}
        >
          {session.current ? null : (
            <button
              type="button"
              disabled={revoke.isPending}
              onClick={() => void guard(() => revoke.mutateAsync(session.id))}
              className={SETTINGS_BUTTON}
            >
              Sign out
            </button>
          )}
        </Setting>
      ))}
      <Setting
        label="Sign in another browser"
        hint={
          mint.data
            ? `Open this link once, before ${new Date(mint.data.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Whoever opens it is signed in as you.`
            : "A link that works once, for 15 minutes."
        }
        stacked={Boolean(mint.data)}
      >
        {mint.data ? (
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
            {mint.data.loopback ? null : (
              <QrCodeCanvas
                value={mint.data.url}
                label="QR code for the sign-in link"
                size={120}
              />
            )}
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <CopyLine value={mint.data.url} />
              {mint.data.loopback ? (
                <p className="text-meta text-muted-foreground">
                  This link only works on this computer. Turn on phone access above to use it
                  elsewhere.
                </p>
              ) : null}
            </div>
          </div>
        ) : (
          <button
            type="button"
            disabled={mint.isPending}
            onClick={() => void guard(() => mint.mutateAsync({}))}
            className={SETTINGS_BUTTON}
          >
            {mint.isPending ? <LoaderCircle aria-hidden className="size-3.5 animate-spin" /> : null}
            Create link
          </button>
        )}
      </Setting>
      {others > 0 ? (
        <Setting
          label="Sign out everywhere else"
          hint={`${others} other ${others === 1 ? "browser" : "browsers"}`}
        >
          <button
            type="button"
            disabled={revokeOthers.isPending}
            onClick={() => void guard(() => revokeOthers.mutateAsync())}
            className={cn(SETTINGS_BUTTON, "text-destructive")}
          >
            Sign them out
          </button>
        </Setting>
      ) : null}
      {pairAgain ? (
        <div className="px-4 py-3 sm:px-5">
          <PairAgain then="Then try again." />
        </div>
      ) : null}
    </SettingsGroup>
  );
}
