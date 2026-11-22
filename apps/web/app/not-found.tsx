import type { Metadata } from "next";
import Link from "next/link";

import { Mascot } from "@/components/brand/mascot";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Page not found",
  robots: { index: false, follow: true },
  alternates: { canonical: null },
};

export default function NotFound() {
  return (
    <main
      id="main-content"
      className="flex min-h-svh flex-col items-center justify-center gap-7 bg-background px-4 text-center text-ink"
    >
      <Mascot alt="" className="auni-float" priority size={168} state="sad" />
      <div className="flex max-w-md flex-col items-center gap-3">
        <h1 className="text-[32px] leading-tight font-semibold tracking-[-0.02em] text-balance sm:text-[40px]">
          This page doesn&apos;t exist.
        </h1>
        <p className="text-[15px] leading-6 text-muted-foreground">
          The link you followed is broken or out of date. Nothing else is broken. Head back to the
          start and ask Auni whatever you came for.
        </p>
      </div>
      <Button asChild className="h-11 rounded-full px-6 text-[15px]">
        <Link href="/">Back to Auni</Link>
      </Button>
    </main>
  );
}
