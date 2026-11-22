"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <html lang="en">
      <body
        style={{
          display: "grid",
          placeItems: "center",
          minHeight: "100vh",
          margin: 0,
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          // This page stands in for the whole app, stylesheet and all, so it wears the browser's
          // own colours for a page and its words, in the light look Auni wears by default.
          colorScheme: "light",
          background: "Canvas",
          color: "CanvasText",
        }}
      >
        <main style={{ textAlign: "center", padding: "2rem" }}>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ opacity: 0.65, maxWidth: "28rem" }}>Your money stays in your own wallet.</p>
          <button
            onClick={reset}
            type="button"
            style={{
              marginTop: "1rem",
              padding: "0.6rem 1.4rem",
              borderRadius: "9999px",
              border: "none",
              background: "CanvasText",
              color: "Canvas",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
