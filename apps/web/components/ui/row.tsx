import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A list of rows, each under a hairline from the one before: holdings, activity, apps, settings.
 * Rows, not tiles: one line of what it is, a quieter line under it, and what it's worth or a
 * control at the end.
 */
function Rows({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="rows"
      className={cn("divide-y divide-border [&>li]:list-none", className)}
      {...props}
    />
  );
}

/**
 * One row: a mark (a logo, an icon), its title and a line under it, and what ends it (a figure, a
 * badge, a switch, a chevron). Give it `onClick` or render it `as="a"`/`"button"` and it presses.
 */
function Row({
  mark,
  title,
  meta,
  end,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  readonly mark?: React.ReactNode;
  readonly title: React.ReactNode;
  readonly meta?: React.ReactNode;
  readonly end?: React.ReactNode;
}) {
  return (
    <div
      data-slot="row"
      className={cn(
        "flex min-h-14 min-w-0 items-center gap-3 py-3",
        props.onClick &&
          "-mx-2 cursor-pointer rounded-control px-2 transition-colors duration-150 hover:bg-foreground/[0.04]",
        className,
      )}
      {...props}
    >
      {mark ? <span className="flex flex-none items-center">{mark}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium text-ink">{title}</span>
        {meta ? (
          <span className="block truncate text-meta text-muted-foreground">{meta}</span>
        ) : null}
        {children}
      </span>
      {end ? (
        <span className="flex flex-none items-center gap-2 text-ui text-ink">{end}</span>
      ) : null}
    </div>
  );
}

export { Row, Rows };
