"use client";

import { RefreshCw } from "lucide-react";
import { useEffect } from "react";

import { Mascot } from "@/components/brand/mascot";
import { Button } from "@/components/ui/button";

/** A screen that threw stays inside the app's frame, with a way back, rather than blanking it. */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
      <Mascot alt="" size={72} state="sad" />
      <h2 className="mt-5 text-amount tracking-[-0.02em] text-ink">Something went wrong</h2>
      <p className="mt-2 max-w-[380px] text-ui leading-[1.5] font-normal text-muted-foreground">
        Your money stays in your own wallet.
      </p>
      <Button onClick={() => retry()} type="button" variant="outline" className="mt-6">
        <RefreshCw aria-hidden />
        Try again
      </Button>
    </div>
  );
}
