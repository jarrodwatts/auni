"use client";

import { appListing, ASK_LINE, type AskCardWire } from "@auni/shared";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { AppMark } from "@/components/apps/app-mark";
import { appHref } from "@/lib/app-links";
import { actionKey, decideAction, useLiveAction } from "@/lib/data/actions";
import { useApps, useRefreshApps } from "@/lib/data/apps";

import { buttonVariants } from "@/components/ui/button";

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

/**
 * Auni offering to turn back on an app the owner switched off, at the moment it would have
 * helped: the app's mark, the card's title in core's words ("Turn <app> on"), Auni's own sentence
 * on what it would add, and what turning it on changes. Allowing it turns the app on and wakes
 * Auni to carry on; Decline says no, which Auni is told. A key an app needs is asked for on a
 * card of its own (secret-card.tsx).
 */
export function ConnectCard({ card }: { readonly card: AskCardWire & { readonly app: string } }) {
  const queryClient = useQueryClient();
  const refreshApps = useRefreshApps();
  const app = useApps().data?.apps.find(({ id }) => id === card.app);
  const live = useLiveAction(card.actionReference);
  const standing = askStanding(
    card.ask,
    live.data?.status ?? card.status,
    live.data?.error ?? null,
  );
  const [pending, setPending] = useState<"allow" | "decline" | null>(null);
  const [failed, setFailed] = useState(false);

  const name = app?.name ?? appListing(card.app)?.name ?? card.app;
  const does = app?.does ?? appListing(card.app)?.does;
  const why = card.lines.find(({ label }) => label === ASK_LINE.why)?.value;
  const changes = card.lines.find(({ label }) => label === ASK_LINE.changes)?.value;
  const mark = <AppMark id={card.app} name={name} size={44} />;

  const decide = async (decision: "allow" | "decline") => {
    setPending(decision);
    setFailed(false);
    try {
      queryClient.setQueryData(
        actionKey(card.actionReference),
        await decideAction(card.actionReference, decision),
      );
      if (decision === "allow") await refreshApps().catch(() => undefined);
    } catch {
      setFailed(true);
    } finally {
      setPending(null);
    }
  };

  if (standing.kind === "ended") {
    const done = standing.tone === "done";
    return (
      <CardFrame
        auni={live.data && done ? { kind: "landed" } : null}
        label={card.summary}
        phase={done ? "confirmed" : "expired"}
      >
        <div data-testid="connect-card" data-standing="ended">
          <CardReceipt
            mark={
              <span className={done ? "flex" : "flex opacity-55 grayscale"}>
                <AppMark id={card.app} name={name} size={38} />
              </span>
            }
            title={done ? `${name} is on` : card.summary}
            detail={done ? "Auni can use it from now on." : standing.label}
            action={
              done ? (
                <Link
                  href={appHref(card.app)}
                  className={buttonVariants({ size: "sm", variant: "secondary" })}
                >
                  Open {name}
                  <ArrowRight aria-hidden className="size-3.5" strokeWidth={2.4} />
                </Link>
              ) : null
            }
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
      <div data-testid="connect-card" data-standing="waiting">
        <CardHead mark={mark} title={card.summary} line={does} />
        {why ? (
          <figure className="mt-5 border-t border-border pt-5">
            <figcaption className="text-caption text-muted-foreground">Why Auni asks</figcaption>
            <blockquote className="mt-1 text-body leading-[1.5] text-pretty text-ink">
              {why}
            </blockquote>
          </figure>
        ) : null}
        {changes ? (
          <p className="mt-4 text-meta leading-[1.45] text-muted-foreground">{changes}</p>
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
              busyLabel="Turning on"
              disabled={busy}
              onClick={() => void decide("allow")}
            >
              <span className="truncate">{card.action}</span>
            </CardButton>
          </CardActions>
        </div>
      </div>
    </CardFrame>
  );
}
