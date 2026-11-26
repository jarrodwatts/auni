"use client";

import type { AskCardWire } from "@auni/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { useState } from "react";

import { TOOL_ICONS } from "@/components/conversation/generic-activity-copy";
import { useRefreshMoney } from "@/components/portfolio/use-portfolio";
import { actionKey, decideAction, useLiveAction } from "@/lib/data/actions";
import { cn } from "@/lib/utils";

import { askFace, doneTitle } from "./ask-face";
import { askStanding } from "./ask-standing";
import {
  CardActions,
  CardAlert,
  CardButton,
  CardFrame,
  CardHead,
  CardReceipt,
  NOT_REACHED_TAP,
} from "./card-parts";
import { ConnectCard } from "./connect-card";
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
    // Done, it reads as a receipt: in the past tense, with how it acts under it, as money cards do.
    const past = done ? doneTitle(face.title) : null;
    return (
      <CardFrame
        auni={live.data && done ? { kind: "landed" } : null}
        label={card.summary}
        phase={done ? "confirmed" : "expired"}
      >
        <div data-testid="ask-card" data-standing="ended">
          <CardReceipt
            mark={<AskMark ask={card.ask} muted={!done} size={38} />}
            title={past ?? face.title}
            detail={past ? face.line : standing.label}
          />
        </div>
      </CardFrame>
    );
  }

  const busy = pending !== null || standing.kind === "working";
  return (
    <CardFrame
      auni={live.data ? { kind: "ready" } : null}
      label={card.summary}
      phase="open"
      tone="waiting"
    >
      <div data-testid="ask-card" data-standing={standing.kind}>
        {/* One head, read like a money card's: what it is on the left, its number on the right. */}
        <CardHead
          mark={<AskMark ask={card.ask} size={44} />}
          title={face.title}
          line={face.line}
          figure={face.figure ? { value: face.figure.value, note: face.figure.label } : null}
        />
        {face.details.length > 0 ? (
          <dl className="mt-5 flex flex-col gap-3.5 border-t border-border pt-5">
            {face.details.map((line) => (
              <div key={line.label} className="min-w-0">
                <dt className="text-caption text-muted-foreground">{line.label}</dt>
                <dd
                  className={cn(
                    "mt-1 text-body leading-[1.45] break-words whitespace-pre-wrap text-ink",
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
        {failed ? <CardAlert>{NOT_REACHED_TAP}</CardAlert> : null}
        <div className="mt-5">
          <CardActions
            decline={{
              busy: pending === "decline",
              disabled: busy,
              onClick: () => void decide("decline"),
            }}
          >
            <CardButton
              tone="primary"
              busy={pending === "allow" || standing.kind === "working"}
              busyLabel="Working on it"
              disabled={busy}
              onClick={() => void decide("allow")}
            >
              <span className="truncate">{face.action}</span>
            </CardButton>
          </CardActions>
        </div>
      </div>
    </CardFrame>
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
        "flex flex-none items-center justify-center rounded-full bg-glyph-plate text-glyph-ink",
        muted && "opacity-55 grayscale",
      )}
      style={{ width: size, height: size }}
    >
      <Icon aria-hidden className="size-5" />
    </span>
  );
}
