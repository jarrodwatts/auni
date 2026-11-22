"use client";

import type { AskCardWire } from "@auni/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useState } from "react";

import { TOOL_ICONS } from "@/components/conversation/generic-activity-copy";
import { useRefreshMoney } from "@/components/portfolio/use-portfolio";
import { actionKey, decideAction, useLiveAction } from "@/lib/data/actions";
import { cn } from "@/lib/utils";

import { askFace } from "./ask-face";
import { askStanding } from "./ask-standing";
import { ConnectCard } from "./connect-card";
import { MoneyButton, MoneyButtons, MoneyCardFrame } from "./money/money-card-parts";
import { SecretCard } from "./secret-card";

/**
 * Auni asking to change Auni itself, not money. It is drawn from a money card's parts: a mark,
 * what the tap agrees to, the one number it is about (a thread's auto budget), every other line
 * the tap agrees to, and two buttons, the main one named for what it does. Once it has ended it
 * rests as a one-line receipt. It reads its action live, as a money card does; an ask applies the
 * moment it's allowed, so it goes straight from waiting to how it ended.
 */
export function AskCard({ card }: { readonly card: AskCardWire }) {
  // An offer of an app is a card of its own, its mark beside its switch; so is a secret asked
  // for, the field it goes in.
  const { app, field } = card;
  if (card.ask === "connect_app" && app) return <ConnectCard card={{ ...card, app }} />;
  if (card.ask === "request_secret" && app && field)
    return <SecretCard card={{ ...card, app, field }} />;
  return <PlainAsk card={card} />;
}

function PlainAsk({ card }: { readonly card: AskCardWire }) {
  const queryClient = useQueryClient();
  const refreshMoney = useRefreshMoney();
  const [pending, setPending] = useState<"allow" | "decline" | null>(null);
  const [failed, setFailed] = useState(false);
  const queryKey = actionKey(card.actionReference);
  const live = useLiveAction(card.actionReference);
  const standing = askStanding(
    card.ask,
    live.data?.status ?? card.status,
    live.data?.error ?? null,
  );
  const face = askFace(card);

  const decide = async (decision: "allow" | "decline") => {
    setPending(decision);
    setFailed(false);
    try {
      queryClient.setQueryData(queryKey, await decideAction(card.actionReference, decision));
      // Refresh threads, budget state, and portfolio wherever the change shows.
      if (decision === "allow") {
        refreshMoney();
        void queryClient.invalidateQueries({ queryKey: ["threads"] });
        void queryClient.invalidateQueries({ queryKey: ["thread-state"] });
      }
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  };

  if (standing.kind === "ended") {
    const done = standing.tone === "done";
    return (
      <MoneyCardFrame
        auni={live.data && done ? { kind: "landed" } : null}
        label={card.summary}
        phase={done ? "confirmed" : "expired"}
      >
        <div className="flex items-center gap-3.5" data-testid="ask-card" data-standing="ended">
          <AskMark ask={card.ask} muted={!done} size={38} />
          <div className="min-w-0 flex-1">
            <p className="text-[15px] leading-5 font-semibold tracking-[-0.01em] text-ink">
              {face.title}
            </p>
            <p className="mt-0.5 line-clamp-2 text-[13px] leading-[1.4] text-muted-foreground">
              {standing.label}
            </p>
          </div>
        </div>
      </MoneyCardFrame>
    );
  }

  const busy = pending !== null || standing.kind === "working";
  return (
    <MoneyCardFrame auni={live.data ? { kind: "ready" } : null} label={card.summary} phase="open">
      <div data-testid="ask-card" data-standing={standing.kind}>
        {/* One header, read like a money card's: what it is on the left, its number on the right. */}
        <div className="flex items-center gap-3">
          <AskMark ask={card.ask} size={44} />
          <div className="min-w-0 flex-1">
            <p className="text-[16.5px] leading-[1.3] font-semibold tracking-[-0.015em] text-balance text-ink">
              {face.title}
            </p>
            {face.line ? (
              <p className="mt-0.5 text-[13px] leading-[18px] text-pretty text-muted-foreground">
                {face.line}
              </p>
            ) : null}
          </div>
          {face.figure ? (
            <div className="flex-none pl-1 text-right">
              <p className="text-[26px] leading-[1.1] font-semibold tracking-[-0.035em] text-ink tabular-nums">
                {face.figure.value}
              </p>
              <p className="mt-0.5 text-[13px] leading-4 text-muted-foreground">
                {face.figure.label}
              </p>
            </div>
          ) : null}
        </div>
        {face.details.length > 0 ? (
          <dl className="mt-5 flex flex-col gap-3.5 border-t border-foreground/[0.06] pt-5">
            {face.details.map((line) => (
              <div key={line.label} className="min-w-0">
                <dt className="text-[12.5px] leading-4 text-muted-foreground">{line.label}</dt>
                <dd
                  className={cn(
                    "mt-1 text-[15px] leading-[1.45] break-words whitespace-pre-wrap text-ink",
                    // A few words read as a value; a routine's whole text reads as prose.
                    line.value.length <= SHORT && "font-semibold tracking-[-0.01em]",
                  )}
                >
                  {line.value}
                </dd>
              </div>
            ))}
          </dl>
        ) : null}
        {failed ? (
          <p role="alert" className="mt-4 text-[13px] text-destructive">
            That didn&apos;t reach Auni, so nothing changed. Try again.
          </p>
        ) : null}
        <div className="mt-5">
          <MoneyButtons>
            <MoneyButton
              tone="quiet"
              busy={pending === "decline"}
              busyLabel="Declining"
              disabled={busy}
              onClick={() => void decide("decline")}
            >
              Not now
            </MoneyButton>
            <MoneyButton
              tone="primary"
              busy={pending === "allow" || standing.kind === "working"}
              busyLabel="Working on it"
              disabled={busy}
              onClick={() => void decide("allow")}
            >
              {face.action}
            </MoneyButton>
          </MoneyButtons>
        </div>
      </div>
    </MoneyCardFrame>
  );
}

/** The longest value drawn as a value, in semibold; a longer one is read as prose. */
const SHORT = 80;

/** What an ask is about, as the step that proposed it is marked: a glyph on a soft round tile. */
function AskMark({
  ask,
  muted = false,
  size,
}: {
  readonly ask: AskCardWire["ask"];
  readonly muted?: boolean;
  readonly size: number;
}) {
  const Icon = TOOL_ICONS[ask] ?? Sparkles;
  return (
    <span
      aria-hidden
      className={cn(
        "flex flex-none items-center justify-center rounded-full bg-primary/[0.08] text-primary",
        muted && "opacity-55 grayscale",
      )}
      style={{ width: size, height: size }}
    >
      <Icon aria-hidden className="size-5" />
    </span>
  );
}
