import * as React from "react";
import { Slot } from "radix-ui";

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

type RowParts = {
  readonly mark?: React.ReactNode;
  readonly title: React.ReactNode;
  readonly meta?: React.ReactNode;
  /** A figure, a badge, a switch or a chevron. A figure here is set tabular. */
  readonly end?: React.ReactNode;
};

/**
 * A row that only says something. Anything under its meta line goes in as children. It takes no
 * onClick: a row that presses is a `PressedRow`, else it's a div no keyboard can reach.
 */
type StillRow = RowParts &
  Omit<React.ComponentProps<"div">, "title" | "onClick"> & {
    readonly asChild?: false;
    readonly onClick?: never;
  };

/**
 * A row that presses: given one element, a `<button type="button">`, a `<Link>` or a Radix
 * trigger, it becomes that element, so Enter and Space and a screen reader treat it as one.
 * Anything under its meta line goes in as that element's children.
 */
type PressedRow = RowParts &
  Omit<React.ComponentProps<"div">, "title" | "children"> & {
    readonly asChild: true;
    readonly children: React.ReactElement<{ readonly children?: React.ReactNode }>;
  };

const ROW = "flex min-h-14 min-w-0 items-center gap-3 py-3";

/** Out to the list's edge by its own padding, so a pressed row's fill doesn't crowd its words. */
const PRESSES =
  "auni-touch-target -mx-2 w-[calc(100%+--spacing(4))] cursor-pointer rounded-control px-2 text-left transition-colors duration-150 hover:bg-foreground/[0.04] focus-ring-inset disabled:cursor-not-allowed disabled:opacity-60";

/** One row: a mark (a logo, an icon), its title and a line under it, and what ends it. */
function Row(props: StillRow | PressedRow) {
  const { mark, title, meta, end, className, asChild, children, ...rest } = props;
  const body = (under: React.ReactNode) => (
    <>
      {mark ? <span className="flex flex-none items-center">{mark}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium text-ink">{title}</span>
        {meta ? (
          <span className="block truncate text-meta text-muted-foreground">{meta}</span>
        ) : null}
        {under}
      </span>
      {end ? (
        <span className="flex flex-none items-center gap-2 text-ui text-ink tabular-nums">
          {end}
        </span>
      ) : null}
    </>
  );

  if (asChild) {
    const element = children as PressedRow["children"];
    return (
      <Slot.Root data-slot="row" className={cn(ROW, PRESSES, className)} {...rest}>
        {React.cloneElement(element, undefined, body(element.props.children))}
      </Slot.Root>
    );
  }
  return (
    <div data-slot="row" className={cn(ROW, className)} {...rest}>
      {body(children)}
    </div>
  );
}

export { Row, Rows };
