"use client";

import "./globals.css";

import { AUNI_REPO_URL } from "@auni/shared";
import { useEffect, useLayoutEffect } from "react";

import { Button } from "@/components/ui/button";
import { LOOK_KEY } from "@/lib/look-first";

import { FONT_VARIABLES } from "./fonts";

/**
 * What shows when the app's own frame threw: this page stands in for the whole document, so it
 * wears the look the owner picked itself, and offers the two ways out there are: load the page
 * again, or tell Auni's makers (with only the error's digest, which names nothing of the owner's).
 * Of money it says only what's true: core runs moves on its own, so a move already allowed may
 * still be going out, and a page can't know it didn't (the in-app error.tsx says the same).
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
            A move you&apos;d already allowed may still be finishing. Reload to see where it stands.
          </p>
          <div className="mt-6 flex gap-2">
            <Button type="button" onClick={() => window.location.reload()}>
              Reload
            </Button>
            <Button asChild variant="outline">
              <a href={report.href} target="_blank" rel="noreferrer">
                Report it
              </a>
            </Button>
          </div>
          {error.digest ? (
            <p className="mt-6 font-mono text-caption font-medium text-faint">{error.digest}</p>
          ) : null}
        </main>
      </body>
    </html>
  );
}
