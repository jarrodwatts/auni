import { Link2, RefreshCw, TerminalSquare } from "lucide-react";
import type { ReactNode } from "react";

import { Mascot, type MascotState } from "@/components/brand/mascot";
import { CopyLine } from "@/components/ui/copy-line";
import { cn } from "@/lib/utils";

/**
 * A whole page before the app: Auni, what's going on, and the way on. Nothing else on it, so the
 * one thing to read and do is all there is. Auni floats while the page carries on by itself.
 */
export function GateScreen({
  pose,
  waiting = false,
  late = false,
  title,
  body,
  children,
}: {
  readonly pose: MascotState;
  /** The page carries on by itself: Auni floats, and the words are read out as they change. */
  readonly waiting?: boolean;
  /** Shown only once the wait is real, so a quick one flashes nothing. */
  readonly late?: boolean;
  readonly title: string;
  readonly body?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <main
      id="main-content"
      className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 pt-10 pb-16"
    >
      <div
        role={waiting ? "status" : undefined}
        className={cn("w-full max-w-[420px] text-center", late && "auni-appear-late")}
      >
        <Mascot
          alt=""
          priority
          size={72}
          state={pose}
          className={cn("mx-auto", waiting ? "auni-float" : "auni-onb-mascot")}
        />
        <h1 className="mt-5 text-title text-balance text-ink">{title}</h1>
        {body ? (
          <p className="mx-auto mt-2 max-w-[380px] text-body text-pretty text-muted-foreground">
            {body}
          </p>
        ) : null}
        {children ? <div className="mt-7 text-left">{children}</div> : null}
      </div>
    </main>
  );
}

/**
 * The trip to the terminal as two steps on one rail: run `auni pair` where Auni runs, then open
 * the link it prints. `then` is what happens once they have.
 */
export function PairSteps({
  machine,
  then,
  className,
}: {
  /** Where Auni runs, by name; null when it's this computer. */
  readonly machine: string | null;
  readonly then: string;
  readonly className?: string;
}) {
  return (
    <ol className={cn("flex flex-col", className)}>
      <Step
        icon={<TerminalSquare />}
        title={`Run this ${machine ? `on ${machine}` : "in a terminal"}`}
      >
        <CopyLine value="auni pair" command className="mt-2" />
      </Step>
      <Step icon={<Link2 />} title="Open the link it prints" last>
        <p className="mt-0.5 text-meta text-muted-foreground">{then}</p>
      </Step>
    </ol>
  );
}

/** One step on the rail: its mark, a hairline down to the next, and what to do. */
function Step({
  icon,
  title,
  last = false,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly last?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <li className="relative flex gap-3.5 pb-5 last:pb-0">
      {last ? null : (
        <span
          aria-hidden
          className="absolute top-9 bottom-1 left-4 w-px -translate-x-1/2 bg-border"
        />
      )}
      <span
        aria-hidden
        className="grid size-8 flex-none place-items-center rounded-full border border-border bg-card text-muted-foreground [&_svg]:size-4"
      >
        {icon}
      </span>
      <div className="min-w-0 flex-1 pt-1.5">
        <p className="text-ui font-medium text-ink">{title}</p>
        {children}
      </div>
    </li>
  );
}

/**
 * Something only the terminal shows: `auni doctor` there, and this page carrying on by itself once
 * whatever was wrong is put right.
 */
export function DoctorSteps({
  machine,
  then,
}: {
  readonly machine: string | null;
  readonly then: string;
}) {
  return (
    <ol className="flex flex-col">
      <Step
        icon={<TerminalSquare />}
        title={`See why ${machine ? `on ${machine}` : "in a terminal"}`}
      >
        <CopyLine value="auni doctor" command className="mt-2" />
      </Step>
      <Step icon={<RefreshCw />} title="Leave this page open" last>
        <p className="mt-0.5 text-meta text-muted-foreground">{then}</p>
      </Step>
    </ol>
  );
}
