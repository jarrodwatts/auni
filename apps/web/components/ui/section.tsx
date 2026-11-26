import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A group on a page or in a sheet: a section heading, an optional line under it, and an action
 * at its end (See all, Add). What it holds sits right under it, with no box around unless the
 * content is a card of its own.
 */
function Section({
  heading,
  description,
  action,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & {
  readonly heading: React.ReactNode;
  readonly description?: React.ReactNode;
  readonly action?: React.ReactNode;
}) {
  return (
    <section data-slot="section" className={cn("min-w-0", className)} {...props}>
      <header className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-section text-ink">{heading}</h2>
          {description ? (
            <p className="mt-0.5 text-meta text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action ? <div className="flex flex-none items-center gap-2">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** A small heading over a group of rows: "Pinned", "Holdings". */
function Eyebrow({ className, ...props }: React.ComponentProps<"h3">) {
  return (
    <h3
      data-slot="eyebrow"
      className={cn("text-caption font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Eyebrow, Section };
