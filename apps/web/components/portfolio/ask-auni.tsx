"use client";

import Link from "next/link";

import { useStartNew } from "@/components/app/use-start-conversation";
import { Mascot } from "@/components/brand/mascot";

/**
 * A phone's way to a new chat from Portfolio, where the sidebar's New isn't
 * showing: one capsule at the thumb, over a short fade so the list dissolves
 * under it instead of being cut.
 */
export function AskAuni() {
  const startNew = useStartNew();
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex justify-center bg-[linear-gradient(to_top,var(--background)_0,var(--background)_28px,--alpha(var(--background)/85%)_52px,transparent_100%)] px-4 pt-10 pb-[max(1.25rem,env(safe-area-inset-bottom))] lg:hidden">
      <Link
        href="/app/new"
        onClick={startNew}
        className="pointer-events-auto flex h-12 items-center gap-2 rounded-full bg-popover pr-6 pl-2.5 border border-border shadow-float transition-transform duration-200 ease-settle outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 active:scale-[0.96] motion-reduce:transition-none"
      >
        <Mascot alt="" size={30} state="color" className="flex-none" />
        <span className="text-reading font-semibold tracking-[-0.01em] text-ink">Ask Auni</span>
      </Link>
    </div>
  );
}
