"use client";

import type { SpecialistId } from "@auni/shared";
import { ArrowUpLeft } from "lucide-react";
import Link from "next/link";

import { Mascot } from "@/components/brand/mascot";
import { SpecialistOrb } from "@/components/specialist/specialist-orb";
import { useSpecialist } from "@/components/specialist/use-specialists";
import { chatHref } from "@/lib/app-links";

/**
 * A conversation with nothing said in it yet. A specialist's invites talk with it, and links back
 * to the chat where it was started, so a take opened from the sidebar reads as the one they just
 * made, not a blank page.
 */
export function EmptyThread({
  specialistId,
  className,
}: {
  readonly specialistId: SpecialistId | null;
  readonly className?: string;
}) {
  const { specialist } = useSpecialist(specialistId ?? undefined);
  const wrap = `flex min-h-[45vh] flex-col items-center justify-center gap-4 px-6 text-center ${className ?? ""}`;
  if (specialist)
    return (
      <div className={wrap}>
        <SpecialistOrb specialist={specialist} size={52} />
        <div className="flex flex-col items-center gap-1.5">
          <h2 className="text-lg font-semibold tracking-tight text-ink">
            Talk to {specialist.name} here
          </h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            Ask how it&apos;s going, or change what it holds.
          </p>
        </div>
        {specialist.startedIn ? (
          <Link
            href={chatHref(specialist.startedIn)}
            className="inline-flex items-center gap-1.5 rounded-full bg-foreground/[0.05] py-1.5 pr-3.5 pl-2.5 text-[13.5px] text-ink-soft transition-colors hover:bg-foreground/[0.08] hover:text-ink"
          >
            <ArrowUpLeft aria-hidden className="size-3.5" />
            See how it started
          </Link>
        ) : null}
      </div>
    );
  return (
    <div className={wrap}>
      <Mascot state="listening" size={52} />
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold tracking-tight">What should your money do?</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Tell me what you want your money to do. I&apos;ll handle the how.
        </p>
      </div>
    </div>
  );
}
