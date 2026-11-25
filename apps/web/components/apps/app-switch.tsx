"use client";

import type { AppWire } from "@auni/shared";
import { useState } from "react";

import { MoneyButton } from "@/components/cards/money/money-card-parts";
import { AutoHeight } from "@/components/motion/auto-height";
import { Switch } from "@/components/ui/switch";
import { CoreApiError } from "@/lib/core";
import { useSwitchApp } from "@/lib/data/apps";

import { waitingFor } from "./app-standing";
import { turningOff } from "./turning-off";

/**
 * An app's switch. Off, Auni is offered none of it and it stops listening; what the owner has
 * there stays theirs and stays in the portfolio. So with money there the sheet first says what
 * off means, and where off would be unsafe (leveraged positions only its own tools can close)
 * it says why and offers the way out.
 */
export function AppSwitch({
  app,
  name,
  busy,
  onAsk,
}: {
  readonly app: AppWire;
  readonly name: string;
  /** A chat is starting, so nothing else may. */
  readonly busy: boolean;
  /** Starts a chat with this message. */
  readonly onAsk: (prompt: string) => void;
}) {
  const switchApp = useSwitchApp();
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState(false);
  // Core's own words when it turns the switch down: it reads the account afresh as it decides.
  const [refusal, setRefusal] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const off = turningOff(app, name);
  // On with something still missing is said as that, never as ready.
  const waits = app.on ? waitingFor(app) : null;

  const turn = async (on: boolean) => {
    setPending(true);
    setFailed(false);
    try {
      await switchApp(app.id, on);
      setAsking(false);
    } catch (error) {
      if (error instanceof CoreApiError && error.detail) setRefusal(error.detail);
      else setFailed(true);
    } finally {
      setPending(false);
    }
  };
  const flip = (on: boolean) => {
    setRefusal(null);
    if (on || off.kind === "free") void turn(on);
    else setAsking(true);
  };

  const refused =
    refusal !== null
      ? { title: `${name} can't be turned off yet`, why: refusal, fix: null }
      : asking && off.kind === "refused"
        ? off
        : null;

  return (
    <AutoHeight className="mt-9">
      {refused ? (
        <div className="rounded-card bg-surface p-5" data-testid="app-switch-refused">
          <h3 className="text-ui font-semibold text-ink">{refused.title}</h3>
          <p className="mt-1.5 text-meta leading-[1.55] text-muted-foreground">{refused.why}</p>
          <div className="mt-4 grid grid-cols-[1fr_1.6fr] gap-2">
            <MoneyButton
              tone="quiet"
              onClick={() => {
                setAsking(false);
                setRefusal(null);
              }}
            >
              Keep it on
            </MoneyButton>
            {refused.fix ? (
              <MoneyButton tone="primary" disabled={busy} onClick={() => onAsk(refused.fix)}>
                Close what&apos;s open
              </MoneyButton>
            ) : (
              <MoneyButton tone="primary" busy={pending} onClick={() => void turn(false)}>
                Try again
              </MoneyButton>
            )}
          </div>
        </div>
      ) : asking && off.kind === "question" ? (
        <div className="rounded-card bg-surface p-5" data-testid="app-switch-question">
          <h3 className="text-ui font-semibold text-ink">{off.title}</h3>
          {off.says.map((line) => (
            <p key={line} className="mt-1.5 text-meta leading-[1.55] text-muted-foreground">
              {line}
            </p>
          ))}
          <div className="mt-4 grid grid-cols-[1fr_1.6fr] gap-2">
            <MoneyButton tone="quiet" disabled={pending} onClick={() => setAsking(false)}>
              Keep it on
            </MoneyButton>
            <MoneyButton
              tone="primary"
              busy={pending}
              busyLabel="Turning it off"
              onClick={() => void turn(false)}
            >
              Turn it off
            </MoneyButton>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-4 rounded-card bg-surface py-3.5 pr-4 pl-5">
          <span className="min-w-0 flex-1">
            <span className="block text-ui font-medium text-ink">
              {waits?.says ?? (app.on ? "On" : "Off")}
            </span>
            <span
              id={`app-switch-${app.id}`}
              className="mt-0.5 block text-meta text-muted-foreground"
            >
              {waits?.under ??
                (app.on
                  ? "Auni can use it when it would help"
                  : "Auni doesn't use it. What you have there stays yours.")}
            </span>
          </span>
          {/* Named for what it turns on and off, not by its state ("On"), which it says itself. */}
          <Switch
            aria-label={name}
            aria-describedby={`app-switch-${app.id}`}
            checked={app.on}
            disabled={pending}
            onCheckedChange={flip}
            data-testid="app-switch"
          />
        </div>
      )}
      {failed ? (
        <p role="alert" className="mt-2 px-1 text-meta text-destructive">
          That didn&apos;t reach Auni, so nothing changed. Try again.
        </p>
      ) : null}
    </AutoHeight>
  );
}
