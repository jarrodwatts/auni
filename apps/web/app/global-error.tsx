"use client";

import "./globals.css";

import { AUNI_REPO_URL } from "@auni/shared";
import { useEffect, useLayoutEffect } from "react";

import { LOOK_KEY } from "@/lib/look-first";

import { FONT_VARIABLES } from "./fonts";

/**
 * What shows when the app's own frame threw: this page stands in for the whole document, so it
 * wears the look the owner picked itself, and offers the two ways out there are: load the page
 * again, or tell Auni's makers (with only the error's digest, which names nothing of the owner's).
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // Before the first paint, as app/layout.tsx's script does for the app.
  useLayoutEffect(() => {
    try {
      const look = localStorage.getItem(LOOK_KEY);
      if (look) document.documentElement.dataset.theme = look;
    } catch {
      // No storage: the light look.
    }
  }, []);

  const report = new URL(`${AUNI_REPO_URL}/issues/new`);
  report.searchParams.set("title", "The web app showed its error page");
  report.searchParams.set("body", `What I was doing:\n\n\nError digest: ${error.digest ?? "none"}`);

  return (
    <html lang="en" className={FONT_VARIABLES} suppressHydrationWarning>
      <body className="grid min-h-dvh place-items-center bg-background px-6 text-center">
        <main className="flex max-w-sm flex-col items-center">
          <h1 className="text-section text-ink">This page hit an error</h1>
          <p className="mt-2 text-body text-muted-foreground">
            Your money is untouched. Loading the page again usually clears it.
          </p>
          <div className="mt-6 flex gap-2">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="h-10 rounded-control bg-ink px-4 text-ui font-medium text-paper hover:bg-ink/90"
            >
              Reload
            </button>
            <a
              href={report.href}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-10 items-center rounded-control border border-border px-4 text-ui font-medium text-ink hover:bg-accent"
            >
              Report it
            </a>
          </div>
          {error.digest ? (
            <p className="mt-6 font-mono text-caption font-medium text-faint">{error.digest}</p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
