"use client";

import type { AppWire } from "@auni/shared";
import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight, Check } from "lucide-react";
import { useEffect } from "react";

import { MoneyButton } from "@/components/cards/money/money-card-parts";
import { useRefreshMe } from "@/components/personalization/use-me";
import { buttonVariants } from "@/components/ui/button";
import { CopyLine } from "@/components/ui/copy-line";
import { useRefreshApps } from "@/lib/data/apps";
import { pairChannel } from "@/lib/data/channels";

import { Section } from "./sheet-section";

/** How often the sheet looks again while a pairing code waits to be sent. */
const PAIRING_CHECK_MS = 3_000;

/**
 * Pairing a chat app with the owner's own chat: a one-time code they send Auni there, good for
 * 15 minutes. Whoever sends it becomes the owner on that app, so the sheet says so. Until the
 * app has what it needs to connect (its token), there is nothing to pair with yet.
 */
export function AppPairing({ app, name }: { readonly app: AppWire; readonly name: string }) {
  const refreshApps = useRefreshApps();
  const refreshMe = useRefreshMe();
  const pairing = useMutation({ mutationFn: () => pairChannel(app.id) });
  const paired = app.pairing === "paired";
  const waiting = Boolean(pairing.data) && !paired;

  // Paired once the code is sent from the chat app, which only core sees: look again till then.
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void refreshApps(), PAIRING_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [waiting, refreshApps]);
  // Where Auni writes to the owner (Settings) lists the chats that are paired.
  useEffect(() => {
    if (paired) refreshMe();
  }, [paired, refreshMe]);

  if (app.pairing === "unset" || !app.on) return null;
  const link = pairing.data?.hint.startsWith("https://") ? pairing.data.hint : null;
  return (
    <Section title="Your chat">
      {waiting && pairing.data ? (
        <div className="flex flex-col gap-3">
          <p className="text-meta leading-[1.55] text-muted-foreground">
            Send this code to Auni in a direct message on {name} within 15 minutes. Whoever sends
            it is paired as you.
          </p>
          <CopyLine value={pairing.data.code} label="Your code" />
          {link ? (
            <a
              className={buttonVariants({ variant: "primary", size: "lg" })}
              href={link}
              rel="noreferrer"
              target="_blank"
            >
              Open in {name}
              <ArrowUpRight aria-hidden className="size-4" strokeWidth={2.2} />
            </a>
          ) : null}
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <p className="flex min-w-0 flex-1 items-center gap-2 text-ui font-normal text-ink">
            {paired ? (
              <>
                <Check aria-hidden className="size-4 flex-none text-ink" strokeWidth={2.6} />
                Paired with your chat
              </>
            ) : (
              <span className="text-muted-foreground">
                Pair your {name} chat so Auni can message you there.
              </span>
            )}
          </p>
          <MoneyButton
            tone={paired ? "quiet" : "primary"}
            busy={pairing.isPending}
            busyLabel="Creating code"
            className="h-10 flex-none px-4 text-ui"
            onClick={() => pairing.mutate()}
          >
            {paired ? "Pair again" : "Pair"}
          </MoneyButton>
        </div>
      )}
      {pairing.isError ? (
        <p role="alert" className="mt-2 text-meta text-destructive">
          Couldn&apos;t make a pairing code. Try again.
        </p>
      ) : null}
    </Section>
  );
}
