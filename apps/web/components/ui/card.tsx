import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A card: flat, a hairline edge, a card's corner. What sits in the page, never floating (only a
 * menu, a sheet, a dialog or the composer casts the shadow). Never a card inside a card: parts of
 * one are `CardSection`s, split by a hairline.
 */
const cardClass = "min-w-0 overflow-hidden rounded-card border border-border bg-card text-ink";

function Card({ className, ...props }: React.ComponentProps<"section">) {
  return <section data-slot="card" className={cn(cardClass, className)} {...props} />;
}

/** A part of a card, under a hairline from the part before it. */
function CardSection({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-section"
      className={cn("px-4 py-3.5 not-first:border-t not-first:border-border sm:px-5", className)}
      {...props}
    />
  );
}

export { Card, CardSection, cardClass };
