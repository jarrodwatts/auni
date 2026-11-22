"use client";

import { CopyLine } from "@/components/ui/copy-line";

/**
 * "Something's wrong?": the one command that starts the owner's own AI looking into it with
 * them (core's `auni triage`). A page can't open a terminal on the computer Auni runs on, which
 * may not be this one, so it says what to run there.
 */
export function HelpPane() {
  return (
    <div className="rounded-[14px] border border-foreground/[0.08] bg-card px-4 py-4">
      <p className="text-[14px] leading-5 font-semibold tracking-[-0.01em] text-ink">
        Something&apos;s wrong?
      </p>
      <p className="mt-1 text-[13px] leading-[1.5] text-pretty text-muted-foreground">
        Run this in a terminal on the computer Auni runs on. Your own Claude Code or Codex reads
        what Auni logged and its code, tells you what it finds, and can write it up as an issue for
        Auni&apos;s GitHub. It never reads your keys or settings, and asks before it changes or
        posts anything.
      </p>
      <CopyLine value="auni triage" command className="mt-3" />
    </div>
  );
}
