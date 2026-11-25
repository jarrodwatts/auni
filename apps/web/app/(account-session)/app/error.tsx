"use client";

import { AUNI_REPO_URL } from "@auni/shared";
import { RefreshCw } from "lucide-react";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/**
 * A screen that threw stays inside the app's frame, with the ways out there are: try it again,
 * or tell Auni's makers (with only the error's digest, which names nothing of the owner's). Of
 * money it says only what's true: a move already allowed may still be going out.
 */
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

  const report = new URL(`${AUNI_REPO_URL}/issues/new`);
  report.searchParams.set("title", "A screen in the web app hit an error");
  report.searchParams.set("body", `What I was doing:\n\n\nError digest: ${error.digest ?? "none"}`);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
      <h2 className="text-section text-ink">This view hit an error</h2>
      <p className="mt-2 max-w-[380px] text-body text-muted-foreground">
        A move you&apos;d already allowed may still be finishing. Try again to see where it stands.
      </p>
      <div className="mt-6 flex gap-2">
        <Button onClick={() => retry()} type="button">
          <RefreshCw aria-hidden />
          Try again
        </Button>
        <Button asChild variant="outline">
          <a href={report.href} target="_blank" rel="noreferrer">
            Report it
          </a>
        </Button>
      </div>
    </div>
  );
}
