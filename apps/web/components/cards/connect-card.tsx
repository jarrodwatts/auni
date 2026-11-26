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

import { askStanding } from "./ask-standing";
import { MoneyButton, MoneyButtons, MoneyCardFrame } from "./money/money-card-parts";

/**
 * Auni offering to turn back on an app the owner switched off, at the moment it would have
 * helped: the app's mark, the card's title in core's words ("Turn <app> on"), Auni's own sentence
 * on what it would add, and what turning it on changes. Allowing it turns the app on and wakes
 * Auni to carry on; Not now declines it, which Auni is told. A key an app needs is asked for on a
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
      <MoneyCardFrame
        auni={live.data && done ? { kind: "landed" } : null}
        label={card.summary}
        phase={done ? "confirmed" : "expired"}
      >
        <div className="flex items-center gap-3.5" data-testid="connect-card" data-standing="ended">
          <span className={done ? undefined : "opacity-55 grayscale"}>
            <AppMark id={card.app} name={name} size={38} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-body leading-5 font-semibold tracking-[-0.01em] text-ink">
              {done ? `${name} is on` : card.summary}
            </p>
            <p className="mt-0.5 line-clamp-2 text-meta leading-[1.4] text-muted-foreground">
              {done ? "Auni can use it from now on" : standing.label}
            </p>
          </div>
          {done ? (
            <Link
              href={appHref(card.app)}
              className="flex h-9 flex-none items-center gap-1 rounded-full bg-foreground/[0.05] px-4 text-ui font-semibold text-ink transition-colors duration-200 ease-settle hover:bg-foreground/[0.08]"
            >
              Open
              <ArrowRight aria-hidden className="size-3.5" strokeWidth={2.4} />
            </Link>
          ) : null}
        </div>
      </MoneyCardFrame>
    );
  }

  const busy = pending !== null || standing.kind === "working";
  return (
    <MoneyCardFrame auni={live.data ? { kind: "ready" } : null} label={card.summary} phase="open">
      <div data-testid="connect-card" data-standing="waiting">
        <div className="flex items-center gap-3">
          {mark}
          <div className="min-w-0 flex-1">
            <p className="text-reading leading-[1.3] font-semibold tracking-[-0.015em] text-ink">
              {card.summary}
            </p>
            {does ? (
              <p className="mt-0.5 text-meta leading-[18px] text-muted-foreground">{does}</p>
            ) : null}
          </div>
        </div>
        {why ? (
          <figure className="mt-5 border-t border-foreground/[0.06] pt-5">
            <figcaption className="text-caption text-muted-foreground">Auni says</figcaption>
            <blockquote className="mt-1 text-body leading-[1.5] text-pretty text-ink">
              {why}
            </blockquote>
          </figure>
        ) : null}
        {changes ? (
          <p className="mt-4 text-meta leading-[1.45] text-muted-foreground">{changes}</p>
        ) : null}
        {failed ? (
          <p role="alert" className="mt-4 text-meta text-destructive">
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
              busyLabel="Turning on"
              disabled={busy}
              onClick={() => void decide("allow")}
            >
              {card.action}
            </MoneyButton>
          </MoneyButtons>
        </div>
      </div>
    </MoneyCardFrame>
  );
}
