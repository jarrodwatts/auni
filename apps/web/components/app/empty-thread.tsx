"use client";

import { Mascot } from "@/components/brand/mascot";

/** A thread with nothing said in it yet. */
export function EmptyThread({ className }: { readonly className?: string }) {
  return (
    <div
      className={`flex min-h-[45vh] flex-col items-center justify-center gap-4 px-6 text-center ${className ?? ""}`}
    >
      <Mascot state="listening" size={52} />
      <div className="flex flex-col gap-1.5">
        <h2 className="text-section">What should your money do?</h2>
        <p className="max-w-sm text-ui text-muted-foreground">
          Tell me what you want your money to do. I&apos;ll handle the how.
        </p>
      </div>
    </div>
  );
}
