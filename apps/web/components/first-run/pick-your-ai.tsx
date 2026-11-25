"use client";

import type { BrainsWire } from "@auni/shared";
import { ArrowRight, Laptop, LockKeyhole, MessageSquareText } from "lucide-react";
import type { ReactNode } from "react";

import { AppMark } from "@/components/apps/app-mark";
import { BrainRow } from "@/components/brains/brain-row";
import { Mascot } from "@/components/brand/mascot";

/**
 * First run when no AI can think yet, the one thing that stops it: what Auni thinks with, a tiny
 * scene of where the owner's login goes (into their own AI, on the machine Auni runs on, and no
 * further), and each AI made ready from here. The moment one is, first run moves on to the take.
 */
export function PickYourAi({
  brains,
  machine,
}: {
  readonly brains: BrainsWire;
  readonly machine: string;
}) {
  return (
    <div className="flex w-full max-w-[480px] flex-col items-center">
      <Mascot alt="" priority size={80} state="listening" className="auni-onb-mascot" />
      <h1 className="mt-4 text-center text-title text-ink">Pick your AI</h1>
      <p className="mt-2 max-w-[400px] text-center text-body text-pretty text-muted-foreground">
        Auni uses the Claude or ChatGPT login you already have. Its work counts toward that plan,
        like your own chats.
      </p>
      <LoginStaysHere ids={brains.rows.map(({ row }) => row.id)} machine={machine} />
      {brains.blocked ? (
        <p
          role="alert"
          className="mt-6 w-full rounded-card border border-border px-4 py-3.5 text-meta text-ink-soft"
        >
          {brains.blocked}
        </p>
      ) : (
        <ul className="mt-6 flex w-full flex-col gap-2.5">
          {brains.rows.map((item) => (
            <BrainRow key={item.row.id} item={item} machine={machine} />
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Where a login goes, as three frames: the owner signs in to their AI, the login stays in it on
 * `machine`, and Auni asks that AI to think. Auni never keeps a copy (core's agent/sign-in.ts).
 */
function LoginStaysHere({
  ids,
  machine,
}: {
  readonly ids: readonly string[];
  readonly machine: string;
}) {
  return (
    <figure className="mt-7 w-full">
      <ol className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-start">
        <Frame at={0} label="You sign in">
          <span className="flex -space-x-2">
            {ids.slice(0, 2).map((id) => (
              <span key={id} className="rounded-control ring-2 ring-background">
                <AppMark id={id} size={36} />
              </span>
            ))}
          </span>
        </Frame>
        <Arrow at={1} />
        <Frame at={2} label={`It stays on ${machine}`}>
          <span className="relative">
            <Laptop aria-hidden className="size-10 text-ink" strokeWidth={1.4} />
            <LockKeyhole
              aria-hidden
              className="absolute -right-1 -bottom-0.5 size-4 rounded-full bg-background text-ink"
              strokeWidth={2.2}
            />
          </span>
        </Frame>
        <Arrow at={3} />
        <Frame at={4} label="Auni asks it to think">
          {/* Auni is the one above the title: the scene shows it at work, not a second time. */}
          <MessageSquareText aria-hidden className="size-10 text-ink" strokeWidth={1.4} />
        </Frame>
      </ol>
      <figcaption className="mt-3 text-center text-meta text-muted-foreground">
        Auni never keeps a copy of your login.
      </figcaption>
    </figure>
  );
}

/** How long after the one before each part of the scene comes in. */
const STEP_MS = 90;

function Frame({
  at,
  label,
  children,
}: {
  readonly at: number;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <li
      className="auni-stagger-in flex min-w-0 flex-col items-center gap-2 text-center"
      style={{ animationDelay: `${200 + at * STEP_MS}ms` }}
    >
      <span className="grid h-12 place-items-center">{children}</span>
      <span className="text-meta text-pretty text-ink-soft">{label}</span>
    </li>
  );
}

function Arrow({ at }: { readonly at: number }) {
  return (
    <li
      aria-hidden
      className="auni-stagger-in mt-4 px-1 text-faint sm:px-2"
      style={{ animationDelay: `${200 + at * STEP_MS}ms` }}
    >
      <ArrowRight className="size-4" />
    </li>
  );
}
