"use client";

import type { BrainsWire, SignInView } from "@auni/shared";
import { ArrowUpRight, Check, LoaderCircle, LockKeyhole } from "lucide-react";
import { useState } from "react";

import { AppMark } from "@/components/apps/app-mark";
import { Button, buttonVariants } from "@/components/ui/button";
import { CopyLine } from "@/components/ui/copy-line";
import { useBrainAsk, typeIntoSignIn } from "@/lib/data/brains";
import { cn } from "@/lib/utils";

import { signInPage } from "./sign-in-page";

type Item = BrainsWire["rows"][number];

const NOT_READY: Record<"not-installed" | "signed-out" | "expired" | "broken", string> = {
  "not-installed": "Not installed",
  "signed-out": "Not signed in",
  expired: "Sign-in has expired",
  broken: "Can't start",
};

/** "your Claude Max subscription" as the start of a line: "Your Claude Max subscription". */
const asStart = (words: string) => words.charAt(0).toUpperCase() + words.slice(1);

const time = (at: string) =>
  new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * One AI Auni can think with, as one calm row: whether its CLI is here and signed in, and the one
 * thing to do about it, done from this screen on any device. Auni installs a missing CLI into its
 * own tools folder, and runs the CLI's own sign-in on `machine`: the page and code to enter there,
 * or the CLI's prompt drawn as a terminal. Whichever device finishes it, every one sees it land.
 */
export function BrainRow({
  item,
  machine,
  named = true,
}: {
  readonly item: Item;
  readonly machine: string;
  /** Its mark and name lead the row; a brain's own sheet, which wears both above, leaves them out. */
  readonly named?: boolean;
}) {
  const { row, task } = item;
  const ask = useBrainAsk();
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = row.state === "ready" || row.state === "resting";
  const run = (kind: "sign-in" | "install" | "stop") => {
    setAsking(true);
    setError(null);
    ask({ id: row.id, kind })
      .catch(() => setError("That didn't reach Auni. Try again."))
      .finally(() => setAsking(false));
  };

  const says = task
    ? task.kind === "installing"
      ? "Installing"
      : task.kind === "signing-in"
        ? "Waiting for you"
        : task.kind === "checking"
          ? "Checking your sign-in"
          : "Didn't finish"
    : row.state === "ready"
      ? row.signedInAs
        ? `Signed in as ${row.signedInAs}`
        : `Ready on ${row.login}`
      : row.state === "resting"
        ? `Resting until ${time(row.until)}`
        : NOT_READY[row.state];
  const under =
    task?.kind === "installing"
      ? `Into Auni's own tools on ${machine}`
      : row.state === "ready" && row.signedInAs
        ? asStart(row.login)
        : row.state === "resting"
          ? `Then ready on ${row.login}`
          : null;
  // The one thing to do, by the row's right edge: never while Auni is already doing something.
  const action =
    task && task.kind !== "failed"
      ? null
      : item.canInstall
        ? { label: task ? "Try again" : "Install", kind: "install" as const }
        : item.canSignIn
          ? {
              label: task ? "Try again" : row.state === "expired" ? "Sign in again" : "Sign in",
              kind: "sign-in" as const,
            }
          : null;
  // What only the owner can do, in a terminal on this computer: one command a line.
  const commands =
    !task && !action && "fix" in row && row.state !== "broken" ? row.fix.split(", then ") : [];

  return (
    <li
      data-testid="brain-row"
      data-brain={row.id}
      className="rounded-card border border-border bg-card p-3.5"
    >
      <div className="flex items-center gap-3">
        {named ? <AppMark id={row.id} name={row.name} size={36} /> : null}
        <span className="min-w-0 flex-1">
          {named ? (
            <span className="block text-body leading-5 font-semibold text-ink">{row.name}</span>
          ) : null}
          <span
            aria-live="polite"
            className={cn(
              "block",
              named
                ? "text-meta leading-[18px] text-muted-foreground"
                : "text-body leading-5 font-medium text-ink",
            )}
          >
            {says}
          </span>
          {under ? <span className="block text-meta text-faint">{under}</span> : null}
        </span>
        {ready && !task ? (
          <span
            aria-hidden
            className="auni-onb-mascot grid size-6 flex-none place-items-center rounded-full bg-ink text-paper"
          >
            <Check className="size-3.5" strokeWidth={2.8} />
          </span>
        ) : task && task.kind !== "failed" && task.kind !== "signing-in" ? (
          <LoaderCircle
            aria-hidden
            className="size-5 flex-none animate-spin text-muted-foreground motion-reduce:animate-none"
          />
        ) : action ? (
          <Button
            className="flex-none"
            disabled={asking}
            aria-busy={asking}
            onClick={() => run(action.kind)}
          >
            {asking ? (
              <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" />
            ) : null}
            {action.label}
          </Button>
        ) : null}
      </div>

      {task?.kind === "signing-in" ? (
        <div className="mt-3.5">
          {task.view === null ? (
            <p className="flex items-center gap-2 text-meta text-muted-foreground">
              <LoaderCircle
                aria-hidden
                className="size-3.5 animate-spin motion-reduce:animate-none"
              />
              Starting {row.name}&apos;s own sign-in on {machine}
            </p>
          ) : task.view.kind === "code" ? (
            <CodeSteps view={task.view} />
          ) : (
            <SignInPrompt view={task.view} name={row.name} machine={machine} />
          )}
          <div className="mt-3 flex items-center justify-end">
            <Button variant="ghost" size="sm" disabled={asking} onClick={() => run("stop")}>
              Cancel
            </Button>
          </div>
        </div>
      ) : task?.kind === "failed" ? (
        <p className="mt-3 rounded-control bg-surface px-3.5 py-2.5 text-meta leading-[19px] text-ink-soft">
          {task.said}
        </p>
      ) : commands.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="text-caption font-medium text-muted-foreground">
            Run {commands.length > 1 ? "these" : "this"} in a terminal on {machine}
          </span>
          {commands.map((command) => (
            <CopyLine key={command} value={command} command />
          ))}
        </div>
      ) : row.state === "broken" && !task ? (
        <p className="mt-2.5 text-meta leading-[19px] text-muted-foreground">{row.fix}</p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2.5 text-meta text-negative">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/** A page's address as a person reads it: its host and path, without what follows. */
function shortUrl(url: string): string {
  const { host, pathname, search } = new URL(url);
  return `${host}${pathname === "/" ? "" : pathname}${search ? "…" : ""}`;
}

/** Codex's device sign-in: the page to open on any device, and the code to enter there. */
function CodeSteps({ view }: { readonly view: Extract<SignInView, { kind: "code" }> }) {
  return (
    <ol className="flex flex-col gap-2.5">
      <li className="flex items-center gap-3 rounded-control bg-surface py-2 pr-2 pl-3.5">
        <Step n={1} />
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-medium text-ink">Open this page</span>
          <span className="block truncate text-meta text-muted-foreground">
            {shortUrl(view.url)}
          </span>
        </span>
        <a
          href={view.url}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ size: "sm", className: "flex-none" })}
        >
          Open
          <ArrowUpRight aria-hidden className="size-3.5" strokeWidth={2.4} />
        </a>
      </li>
      <li className="flex items-start gap-3 rounded-control bg-surface py-2.5 pr-2 pl-3.5">
        <Step n={2} />
        <span className="min-w-0 flex-1">
          <span className="block text-ui font-medium text-ink">Enter this code there</span>
          <CopyLine
            value={view.code}
            className="mt-1.5 [&_code]:text-reading [&_code]:tracking-[0.12em] [&>div]:bg-card"
          />
        </span>
      </li>
    </ol>
  );
}

function Step({ n }: { readonly n: number }) {
  return (
    <span
      aria-hidden
      className="grid size-6 flex-none place-items-center rounded-full bg-card text-caption font-semibold text-muted-foreground"
    >
      {n}
    </span>
  );
}

/**
 * A CLI's own sign-in prompt (Claude Code's), as the two things a person does with it: open the
 * sign-in page it printed, and paste the code that page gives back. What is pasted lives in this
 * component alone, goes only to core's private field for this sign-in, and on to the CLI's prompt;
 * the CLI prints no echo of it, so it shows nowhere. What the CLI printed is there to read, folded.
 */
function SignInPrompt({
  view,
  name,
  machine,
}: {
  readonly view: Extract<SignInView, { kind: "terminal" }>;
  readonly name: string;
  readonly machine: string;
}) {
  const [line, setLine] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const page = signInPage(view.output);

  const send = () => {
    if (!line.trim() || sending) return;
    setSending(true);
    setError(null);
    typeIntoSignIn(view.field, line)
      .then(() => setLine(""))
      .catch(() => setError(`That didn't reach ${name}'s sign-in. Try again.`))
      .finally(() => setSending(false));
  };

  return (
    <div className="flex flex-col gap-2.5">
      {page ? (
        <a
          href={page}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ size: "lg", className: "w-full" })}
        >
          Open {name} sign-in
          <ArrowUpRight aria-hidden className="size-4" strokeWidth={2.4} />
        </a>
      ) : (
        <p className="flex h-11 items-center justify-center gap-2 text-meta text-muted-foreground">
          <LoaderCircle aria-hidden className="size-3.5 animate-spin motion-reduce:animate-none" />
          Opening {name}&apos;s sign-in
        </p>
      )}
      <form
        className="flex items-center gap-1.5 rounded-control border border-input bg-card py-1 pr-1 pl-3.5 focus-within:border-ring/50"
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
      >
        <LockKeyhole aria-hidden className="size-3.5 flex-none text-muted-foreground" />
        <input
          type="password"
          value={line}
          aria-label={`The code from ${name}'s sign-in`}
          placeholder="Paste the code"
          disabled={sending}
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          onChange={(event) => setLine(event.target.value)}
          className="h-9 min-w-0 flex-1 bg-transparent text-ui text-ink outline-none placeholder:text-faint"
        />
        <Button type="submit" size="sm" disabled={!line.trim() || sending}>
          Send
        </Button>
      </form>
      <p className="text-center text-meta text-muted-foreground">
        Only {name} on {machine} sees it.
      </p>
      {error ? (
        <p role="alert" className="text-meta text-negative">
          {error}
        </p>
      ) : null}
      <details className="group text-meta text-muted-foreground">
        <summary className="w-fit cursor-pointer rounded-control px-1 outline-none hover:text-ink focus-visible:ring-[3px] focus-visible:ring-ring/35">
          What {name} printed
        </summary>
        {/* A few lines of it, fading at the foot and scrolling for the rest, so a long link it
            printed never pushes the sign-in out from over the reply box. */}
        <pre className="mt-2 max-h-[84px] overflow-y-auto rounded-control bg-surface px-3 pt-2.5 pb-4 font-mono text-caption leading-[17px] whitespace-pre-wrap wrap-anywhere text-ink-soft [mask-image:linear-gradient(to_bottom,black_70%,transparent)]">
          <span className="text-faint">$ {view.command}</span>
          {"\n"}
          {view.output}
        </pre>
      </details>
    </div>
  );
}
