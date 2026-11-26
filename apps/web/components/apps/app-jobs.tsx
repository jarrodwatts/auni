import { listed, type AppJob, type AppWire } from "@auni/shared";
import {
  ArrowLeftRight,
  BellRing,
  Coins,
  Eye,
  Hourglass,
  KeyRound,
  MessageCircle,
  MousePointerClick,
  PieChart,
  ReceiptText,
  Send,
  Sparkles,
  Tag,
  Wallet,
  Waypoints,
  type LucideIcon,
} from "lucide-react";

import { AppMark } from "./app-mark";
import { Section } from "./sheet-section";

/** One beat of a job's scene: what happens, behind a glyph, or behind the app's own mark. */
interface Beat {
  readonly icon: LucideIcon | "app";
  readonly says: string;
}

/**
 * Each job an app can do for Auni itself: the row "What Auni runs on" lists it under, and the
 * job as a scene of three beats, what sets it off, what the app does, and what the owner sees.
 */
export const JOBS: Record<
  AppJob,
  {
    readonly label: string;
    readonly icon: LucideIcon;
    /** When the scene plays, as its heading: "When you trade". */
    readonly when: string;
    readonly scene: (name: string) => readonly [Beat, Beat, Beat];
    /** What comes before the other apps that do the same job: "Auni also asks". */
    readonly also: string;
  }
> = {
  thinks: {
    label: "Thinks with",
    icon: Sparkles,
    when: "When you talk to Auni",
    scene: (name) => [
      { icon: MessageCircle, says: "You say something to Auni" },
      { icon: "app", says: `${name} thinks it through` },
      { icon: ReceiptText, says: "Auni answers, or puts a card in front of you" },
    ],
    also: "Also thinking",
  },
  keys: {
    label: "Keeps your keys with",
    icon: KeyRound,
    when: "When you allow a move",
    scene: (name) => [
      { icon: MousePointerClick, says: "You tap Allow on a card" },
      { icon: "app", says: `${name} signs exactly what the card showed` },
      { icon: Send, says: "Only then does your money move" },
    ],
    also: "Also signing",
  },
  trades: {
    label: "Trades through",
    icon: ArrowLeftRight,
    when: "When you trade",
    scene: (name) => [
      { icon: MessageCircle, says: "You ask for a swap or a stock" },
      { icon: "app", says: `Auni asks ${name} what it would cost` },
      { icon: ReceiptText, says: "The best price Auni finds goes on your card" },
    ],
    also: "Auni also asks",
  },
  moves: {
    label: "Moves cash with",
    icon: Waypoints,
    when: "When cash changes chains",
    scene: (name) => [
      { icon: Coins, says: "Your cash is on one chain and is needed on another" },
      { icon: "app", says: `${name} carries it across` },
      { icon: Hourglass, says: "Auni waits for it to land, then carries on" },
    ],
    also: "Also carries cash",
  },
  prices: {
    label: "Prices tokens with",
    icon: Tag,
    when: "When Auni reads what you hold",
    scene: (name) => [
      { icon: Wallet, says: "Auni finds a token in your wallet" },
      { icon: "app", says: `It asks ${name} what the token is and what it is worth` },
      { icon: PieChart, says: "Your portfolio shows it by name, with its value" },
    ],
    also: "Auni also asks",
  },
  watches: {
    label: "Watches with",
    icon: Eye,
    when: "While you are away",
    scene: (name) => [
      { icon: MessageCircle, says: "You ask Auni to keep an eye on something" },
      { icon: "app", says: `${name} keeps watching for it` },
      { icon: BellRing, says: "When it happens, Auni wakes and tells you" },
    ],
    also: "Also watching",
  },
};

/**
 * What an app does for Auni itself, each job as a scene of three beats with the app in the
 * middle, and under it the other apps Auni turns to for the same job, each a way into its own
 * sheet. One that another app is doing the job of says who, in place of a scene that isn't
 * playing.
 */
export function AppJobs({
  app,
  apps,
  onOpen,
  whichBrain,
}: {
  readonly app: AppWire;
  /** Every app in this Auni, to name the others that do the same job. */
  readonly apps: readonly AppWire[];
  readonly onOpen: (id: string) => void;
  /** Core's one sentence on which brain answers, said under a brain's scene. */
  readonly whichBrain: string | null;
}) {
  // A brain says the rule that picks it; any other app's job is plain from its scene.
  const rule = app.jobs.includes("thinks") ? whichBrain : null;
  const doing = (job: AppJob) =>
    apps
      .filter((other) => other.id !== app.id && other.inUse && other.jobs.includes(job))
      .toSorted((a, b) => a.name.localeCompare(b.name));
  if (!app.inUse) {
    const names = [...new Set(app.jobs.flatMap((job) => doing(job).map(({ name }) => name)))];
    return (
      <Section title="Not in use">
        <p className="text-ui leading-[1.5] font-normal text-muted-foreground">
          {names.length > 0
            ? `${listed(names)} does this job now.`
            : "Another app does this job now."}{" "}
          {rule ?? "Which one does it is set in Auni's settings file."}
        </p>
      </Section>
    );
  }
  return app.jobs.map((job, index) => {
    const others = doing(job);
    return (
      <Section key={job} title={JOBS[job].when}>
        <ol className="relative flex flex-col gap-3.5">
          <span
            aria-hidden
            className="absolute top-4 bottom-4 left-[15px] w-px bg-foreground/[0.09]"
          />
          {JOBS[job].scene(app.name).map((beat) => (
            <li key={beat.says} className="relative flex items-center gap-3.5">
              {beat.icon === "app" ? (
                <span className="flex size-8 flex-none items-center justify-center rounded-control bg-popover">
                  <AppMark id={app.id} name={app.name} size={32} />
                </span>
              ) : (
                <span className="flex size-8 flex-none items-center justify-center rounded-full bg-surface text-muted-foreground">
                  <beat.icon aria-hidden className="size-[15px]" strokeWidth={1.9} />
                </span>
              )}
              <span className="min-w-0 flex-1">
                <span
                  className={
                    beat.icon === "app"
                      ? "block text-ui leading-[1.4] font-medium text-ink"
                      : "block text-ui leading-[1.4] font-normal text-muted-foreground"
                  }
                >
                  {beat.says}
                </span>
                {/* How it stands now: the login it thinks on, when its limit lifts. */}
                {beat.icon === "app" && index === 0 && app.standing ? (
                  <span className="mt-0.5 block text-meta text-muted-foreground">
                    {app.standing}
                  </span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
        {others.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1.5 pl-[46px]">
            <span className="text-meta text-faint">{JOBS[job].also}</span>
            {others.map((other) => (
              <button
                key={other.id}
                type="button"
                onClick={() => onOpen(other.id)}
                className="flex h-7 items-center gap-1.5 rounded-full bg-surface pr-2.5 pl-1 text-meta font-medium text-ink transition-colors duration-150 outline-none hover:bg-foreground/[0.06] focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <AppMark id={other.id} name={other.name} size={20} />
                {other.name}
              </button>
            ))}
          </div>
        ) : null}
        {job === "thinks" && rule ? (
          <p className="mt-3 pl-[46px] text-meta text-muted-foreground">{rule}</p>
        ) : null}
      </Section>
    );
  });
}
