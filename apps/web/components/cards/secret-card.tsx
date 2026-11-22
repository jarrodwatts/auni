"use client";

import { appListing, ASK_LINE, SOLANA_BRING_FIELD, type AskCardWire } from "@auni/shared";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { quietPillClass } from "@/components/apps/app-keys";
import { AppMark } from "@/components/apps/app-mark";
import { PairAgain } from "@/components/auth/pair-again";
import { PrivateInput } from "@/components/private-input/private-input";
import { usePrivateField } from "@/components/private-input/use-private-field";
import { settingsDialogHref } from "@/lib/app-links";
import { actionKey, decideAction, useLiveAction } from "@/lib/data/actions";
import { useRefreshApps } from "@/lib/data/apps";

import { askStanding } from "./ask-standing";
import { MoneyButton, MoneyCardFrame } from "./money/money-card-parts";

/** The address that opens a secret's card with its field ready, as a chat app's link does. */
const CARD_PARAM = "card";

/**
 * Auni asking for a secret core takes in one of its private fields: an app's key, a Solana key
 * the owner holds, a sign-in code. Every word but Auni's one sentence on why is core's: the
 * name, the line on where it goes, and the app's own Get a key. What is pasted goes straight to
 * core's `/private/:id`, which saves it and settles this card; the card itself carries no value.
 * A field that takes proof the owner is there says so before anything is pasted.
 */
export function SecretCard({
  card,
}: {
  readonly card: AskCardWire & { readonly field: string; readonly app: string };
}) {
  const queryClient = useQueryClient();
  const refreshApps = useRefreshApps();
  const pathname = usePathname();
  const search = useSearchParams();
  const live = useLiveAction(card.actionReference);
  const standing = askStanding(
    card.ask,
    live.data?.status ?? card.status,
    live.data?.error ?? null,
  );
  const loaded = usePrivateField(standing.kind === "waiting" ? card.field : null);
  const [declining, setDeclining] = useState(false);
  const [failed, setFailed] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opened = search.get(CARD_PARAM) === card.actionReference;

  // Opened from a chat app's link to it: in view, with the cursor in its field.
  useEffect(() => {
    if (!opened || loaded.kind !== "ready") return;
    frame.current?.scrollIntoView({ block: "center" });
    input.current?.focus({ preventScroll: true });
  }, [opened, loaded.kind]);

  const name = appListing(card.app)?.name ?? card.app;
  const why = card.lines.find(({ label }) => label === ASK_LINE.why)?.value;
  const mark = <AppMark id={card.app} name={name} size={40} />;
  const wallet = loaded.kind === "ready" && loaded.field.confirms;
  // A key added to the wallet isn't in the backup the owner saved before it.
  const backsUp = card.field === SOLANA_BRING_FIELD;

  const read = () => queryClient.invalidateQueries({ queryKey: actionKey(card.actionReference) });
  const decline = async () => {
    setDeclining(true);
    setFailed(false);
    try {
      queryClient.setQueryData(
        actionKey(card.actionReference),
        await decideAction(card.actionReference, "decline"),
      );
    } catch {
      setFailed(true);
    } finally {
      setDeclining(false);
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
        <div className="flex items-center gap-3.5" data-testid="secret-card" data-standing="ended">
          <span className={done ? undefined : "opacity-55 grayscale"}>{mark}</span>
          <div className="min-w-0 flex-1">
            <p className="text-[15px] leading-5 font-semibold tracking-[-0.01em] text-ink">
              {card.summary}
            </p>
            <p className="mt-0.5 line-clamp-2 text-[13px] leading-[1.4] text-muted-foreground">
              {done && backsUp
                ? "Saved. Back up your keys again, as your last backup doesn't have it"
                : standing.label}
            </p>
          </div>
          {done && backsUp ? (
            <Link
              href={settingsDialogHref(pathname, search.toString(), "wallet")}
              className={quietPillClass}
            >
              Back up
            </Link>
          ) : null}
        </div>
      </MoneyCardFrame>
    );
  }

  const link = loaded.kind === "ready" ? loaded.field.link : null;
  return (
    <MoneyCardFrame auni={live.data ? { kind: "ready" } : null} label={card.summary} phase="open">
      <div ref={frame} data-testid="secret-card" data-standing="waiting">
        <div className="flex items-center gap-3">
          {mark}
          <p className="min-w-0 flex-1 text-[16.5px] leading-[1.3] font-semibold tracking-[-0.015em] text-ink">
            {card.summary}
          </p>
          {link ? (
            <a href={link} target="_blank" rel="noopener noreferrer" className={quietPillClass}>
              Get a key
            </a>
          ) : null}
        </div>
        {why ? <p className="mt-4 text-[15px] leading-[1.5] text-pretty text-ink">{why}</p> : null}
        <div className="mt-5">
          {loaded.kind === "ready" ? (
            <PrivateInput
              named
              field={loaded.field}
              words={{
                check: "Check key",
                preview: "This key signs for",
                confirm: wallet ? "Add to wallet" : card.action,
              }}
              secondary={{ label: "Not now", busy: declining, onClick: () => void decline() }}
              inputRef={input}
              onDone={() => {
                void read();
                void refreshApps().catch(() => undefined);
              }}
            />
          ) : loaded.kind === "loading" ? (
            <div aria-hidden className="h-[124px]" />
          ) : (
            <div className="flex flex-col gap-3">
              {loaded.kind === "pair_again" ? (
                <PairAgain then="Then paste it here." />
              ) : (
                <p className="text-[13px] leading-[18px] text-muted-foreground">
                  {loaded.kind === "gone"
                    ? "There's nothing to paste here any more."
                    : "That didn't reach Auni. Try again."}
                </p>
              )}
              <MoneyButton
                tone="quiet"
                busy={declining}
                busyLabel="Not now"
                onClick={() => void decline()}
              >
                Not now
              </MoneyButton>
            </div>
          )}
        </div>
        {failed ? (
          <p role="alert" className="mt-3 text-[13px] text-destructive">
            That didn&apos;t reach Auni, so nothing changed. Try again.
          </p>
        ) : null}
      </div>
    </MoneyCardFrame>
  );
}
