"use client";

import { appListing, type AppWire } from "@auni/shared";
import { ArrowDownLeft, ArrowUpRight } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { useAppDialogs } from "@/components/app/app-dialogs";
import { useStartConversation } from "@/components/app/use-start-conversation";
import { Mascot } from "@/components/brand/mascot";
import { AutoHeight } from "@/components/motion/auto-height";
import { BrainRow } from "@/components/brains/brain-row";
import { AssetLogo } from "@/components/brand/marks";
import { AuniSheet } from "@/components/ui/auni-sheet";
import { useBrains } from "@/lib/data/brains";
import { formatUsd } from "@/lib/money";
import { useMediaQuery } from "@/lib/use-viewport";
import { cn } from "@/lib/utils";

import { AppJobs } from "./app-jobs";
import { AppKeysNeeded, AppSettings } from "./app-keys";
import { AppMark, appTint } from "./app-mark";
import { AppPairing } from "./app-pairing";
import { keysNeeded } from "./app-standing";
import { AppSwitch } from "./app-switch";
import { Section } from "./sheet-section";

/** A way to try an app, as a pill; one that can't be tapped yet is the same pill, pale. */
const CHIP =
  "flex h-10 max-w-full items-center rounded-full border px-4 text-[13.5px] font-medium tracking-[-0.01em]";

/**
 * One app, opened from the Apps list: the keys it still needs, what the owner has there, ways
 * to try it (each starts a chat), what it does for Auni itself as a scene, how money gets in
 * and out in the app's own words, its other settings, and its switch.
 * It comes from the right where there is room and from the bottom on a phone.
 */
export function AppSheet({
  app,
  apps,
  settingsFile,
  whichBrain,
  open,
  onOpenChange,
  onOpen,
}: {
  readonly app: AppWire;
  /** Every app in this Auni, for the others that do the same job. */
  readonly apps: readonly AppWire[];
  /** Where the owner's settings file is, for a setting only that file changes. */
  readonly settingsFile: string;
  /** Which brain answers, said in a brain's sheet; null with only one brain. */
  readonly whichBrain: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Opens another app's sheet in place of this one. */
  readonly onOpen: (id: string) => void;
}) {
  const wide = useMediaQuery("(min-width: 640px)");
  const starts = appListing(app.id)?.starts ?? [];
  const { name } = app;
  const holds = Number(app.account?.usd ?? 0) >= 0.01;
  // An app that only waits for a key opens with the cursor in its field, where there is a
  // keyboard already: on a phone that would throw one up over the sheet.
  const firstKey = useRef<HTMLInputElement>(null);
  const asksKey = keysNeeded(app).length > 0;
  // The moment its last key went in, said once, while this sheet stays open.
  const [connected, setConnected] = useState(false);
  // What the owner could do with it is live once nothing is missing, or money is there already.
  const ready = Boolean(app.account) || app.needs.length === 0;
  const { busy, start } = useStartConversation();
  const { openReport } = useAppDialogs();
  // The chat a tap starts takes the place of this page, and the sheet goes with it.
  const ask = (prompt: string) => void start(prompt);
  return (
    <AuniSheet
      open={open}
      onOpenChange={onOpenChange}
      side={wide ? "right" : "bottom"}
      title={name}
      initialFocus={wide && asksKey ? firstKey : undefined}
      wash={appTint(app.id)}
      className="sm:w-[420px]"
    >
      <div
        className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-9 pb-[max(1.75rem,env(safe-area-inset-bottom))] sm:pt-8"
        data-testid="app-sheet"
        data-app={app.id}
      >
        <header className="relative flex items-center gap-4 pr-8">
          <AppMark id={app.id} name={app.name} size={56} />
          <div className="min-w-0">
            <h2 className="truncate text-[22px] leading-7 font-semibold tracking-[-0.03em] text-ink">
              {name}
            </h2>
            {app.does ? (
              <p className="mt-0.5 text-ui font-normal text-muted-foreground">{app.does}</p>
            ) : null}
          </div>
        </header>

        <div className="relative">
          {app.jobs.includes("thinks") ? <BrainSection id={app.id} /> : null}
          {/* What keeps going wrong for it now comes before anything it could do. */}
          {app.troubles.length > 0 ? (
            <Section title="What isn't working">
              <ul className="grid gap-2" data-testid="app-troubles">
                {app.troubles.map((trouble) => (
                  <li key={trouble.says} className="rounded-xl bg-surface px-4 py-3">
                    <span className="block text-ui font-medium text-ink">{trouble.short}</span>
                    <span className="mt-0.5 block text-meta text-muted-foreground">
                      {trouble.says}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          {/* The owner's money comes first; with none there, what the app still needs does. */}
          {holds ? <Holdings app={app} /> : null}
          <AutoHeight>
            {connected && !asksKey ? (
              <div className="mt-8 flex items-center gap-3.5" data-testid="app-connected">
                <Mascot className="auni-onb-mascot flex-none" size={44} state="celebrating" />
                <span className="min-w-0 flex-1">
                  <span className="block text-ui font-semibold text-ink">{name} is connected</span>
                  <span className="mt-0.5 block text-meta text-muted-foreground">
                    Auni can use it from its next step.
                  </span>
                </span>
              </div>
            ) : null}
            {/* What the key is for comes before the key: the same chips, waiting. */}
            {app.on && starts.length > 0 && !ready ? (
              <Section title={asksKey ? "With a key, Auni can" : "Once it is set up, Auni can"}>
                <ul className="flex flex-wrap gap-2">
                  {starts.map((way) => (
                    <li
                      key={way.title}
                      className={cn(CHIP, "border-transparent bg-surface text-muted-foreground")}
                    >
                      <span className="truncate">{way.title}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            ) : null}
            <AppKeysNeeded app={app} focusRef={firstKey} onSaved={() => setConnected(true)} />
          </AutoHeight>
          {app.pairing ? <AppPairing app={app} name={name} /> : null}
          {app.account && !holds ? <Holdings app={app} /> : null}
          {app.on && starts.length > 0 && ready ? (
            <Section title="Try it">
              <ul className={cn("flex flex-wrap gap-2", connected && "auni-stagger-in")}>
                {starts.map((way) => (
                  <li key={way.title} className="max-w-full">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => ask(way.prompt)}
                      className={cn(
                        CHIP,
                        "border-foreground/[0.08] bg-card text-ink shadow-[0_1px_2px_--alpha(var(--color-shade)/4%)] transition-[transform,box-shadow,border-color] duration-200 ease-settle hover:-translate-y-px hover:border-foreground/[0.12] hover:shadow-[0_6px_16px_-8px_--alpha(var(--color-shade)/22%)] focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-60",
                      )}
                    >
                      <span className="truncate">{way.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          {/* One Auni's own work runs on says what that work is; one the owner acts through has its chips. */}
          {app.canSwitch ? null : (
            <AppJobs app={app} apps={apps} onOpen={onOpen} whichBrain={whichBrain} />
          )}
          {app.account ? (
            <Section title="Money in and out">
              <div
                className={cn(
                  "grid gap-2.5",
                  // Two moves sit side by side; words take the width they need.
                  !app.account.moneyIn && !app.account.moneyOut && "grid-cols-2",
                )}
              >
                <Way
                  words={app.account.moneyIn}
                  off={!app.on}
                  busy={busy}
                  icon={<ArrowDownLeft aria-hidden className="size-4" strokeWidth={2.2} />}
                  label="Put money in"
                  onAsk={() => ask(`I want to put money into ${name}.`)}
                />
                <Way
                  words={app.account.moneyOut}
                  off={!app.on}
                  busy={busy}
                  icon={<ArrowUpRight aria-hidden className="size-4" strokeWidth={2.2} />}
                  label="Take money out"
                  onAsk={() => ask(`I want to take money out of ${name}.`)}
                />
              </div>
              {app.on || (app.account.moneyIn && app.account.moneyOut) ? null : (
                <p className="mt-2.5 text-meta text-muted-foreground">
                  Turn it on to move money here.
                </p>
              )}
            </Section>
          ) : null}
          <AppSettings app={app} settingsFile={settingsFile} />
          {app.canSwitch ? (
            <AppSwitch app={app} name={name} busy={busy} onAsk={ask} />
          ) : (
            <p className="mt-9 text-meta leading-[1.5] text-muted-foreground">
              {app.inUse
                ? "Auni's own work runs on this, so it has no switch."
                : "It has no switch: it does nothing until Auni's settings file names it."}
            </p>
          )}
          <p className="mt-6 text-meta leading-[1.5] text-muted-foreground">
            Something wrong with it?{" "}
            <button
              type="button"
              onClick={() => openReport({ app: app.id })}
              className="font-medium text-ink underline decoration-foreground/25 underline-offset-2 hover:decoration-foreground/60"
              data-testid="app-report"
            >
              Report a problem
            </button>
          </p>
        </div>
      </div>
    </AuniSheet>
  );
}

/** What the owner has there, from Auni's last reading: the total, then each thing held. */
function Holdings({ app }: { readonly app: AppWire }) {
  const account = app.account!;
  if (account.usd === null)
    return (
      <Section title="You have">
        <p className="text-ui font-normal text-muted-foreground">
          Auni couldn&apos;t read it just now. What you have there is still yours.
        </p>
      </Section>
    );
  if (account.holdings.length === 0)
    return (
      <Section title="You have">
        <p className="text-ui font-normal text-muted-foreground">Nothing there yet.</p>
      </Section>
    );
  const own = appListing(app.id)?.logo;
  return (
    <section aria-label="You have" className="mt-8">
      <p className="text-[40px] leading-none font-semibold tracking-[-0.045em] text-ink tabular-nums">
        {formatUsd(account.usd)}
      </p>
      <p className="mt-1.5 text-meta text-muted-foreground">there now</p>
      <ul className="mt-4 flex flex-col">
        {account.holdings.map((holding) => (
          <li key={holding.id} className="flex min-h-[60px] items-center gap-3">
            {holding.logoUrl === own ? (
              // The app's own logo, whole on its own tile, cut round like the pictures beside it.
              <span className="flex-none overflow-hidden rounded-full">
                <AppMark id={app.id} name={app.name} size={38} />
              </span>
            ) : (
              <AssetLogo holding={holding} size={38} />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-reading leading-[22px] text-ink">
                {holding.name}
              </span>
              <span className="block truncate text-meta text-muted-foreground">
                {holding.detail}
              </span>
            </span>
            <span className="flex-none text-reading leading-[22px] font-semibold tracking-[-0.01em] text-ink tabular-nums">
              {formatUsd(holding.usdValue)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One direction money moves: a button that asks Auni for it where the app has a move for that,
 * else the app's own words on how it happens, so a gap is said and never hidden.
 */
function Way({
  words,
  off,
  busy,
  icon,
  label,
  onAsk,
}: {
  readonly words: string | null;
  readonly off: boolean;
  readonly busy: boolean;
  readonly icon: ReactNode;
  readonly label: string;
  readonly onAsk: () => void;
}) {
  if (words)
    return (
      <p className="flex gap-3 text-meta leading-[1.55] text-muted-foreground">
        <span className="mt-px flex size-[18px] flex-none items-center justify-center text-faint">
          {icon}
        </span>
        <span className="min-w-0 flex-1">{words}</span>
      </p>
    );
  return (
    <button
      type="button"
      disabled={busy || off}
      onClick={onAsk}
      className={cn(
        "flex h-11 min-w-0 items-center justify-center gap-2 rounded-full bg-foreground/[0.05] px-4 text-[14.5px] font-semibold text-ink transition-[background-color,scale] duration-200 ease-settle hover:bg-foreground/[0.08] focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none active:scale-[0.985] disabled:pointer-events-none disabled:opacity-55",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

/**
 * A brain's sign-in, as first run shows it: installed or not, signed in or not, and the one thing
 * to do about it from here, on any device.
 */
function BrainSection({ id }: { readonly id: string }) {
  const brains = useBrains();
  const item = brains.data?.rows.find(({ row }) => row.id === id);
  if (!item) return null;
  return (
    <Section title="Sign-in">
      <ul>
        <BrainRow item={item} machine={brains.data!.machine} named={false} />
      </ul>
    </Section>
  );
}
