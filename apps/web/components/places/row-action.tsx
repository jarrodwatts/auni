"use client";

import type { ReactNode, Ref } from "react";

import { Hint } from "./sidebar-rows";

/** A small icon button over a sidebar row, named by a hint, such as a chat's Rename. */
export function RowAction({
  ref,
  label,
  name,
  onClick,
  children,
}: {
  readonly ref?: Ref<HTMLButtonElement>;
  /** What the hint says. */
  readonly label: string;
  /** What a screen reader says, with the row's name. */
  readonly name: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Hint label={label} side="bottom">
      <button
        ref={ref}
        type="button"
        aria-label={name}
        onClick={onClick}
        className="auni-touch-target flex size-6 items-center justify-center rounded-[6px] text-muted-foreground outline-none transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-ink focus-visible:text-ink focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {children}
      </button>
    </Hint>
  );
}
