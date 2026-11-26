import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";

/**
 * Every button in Auni, as classes, for a `<Button>` or anything that must look like one (a
 * link, a Radix trigger, a dialog's action).
 *
 *   primary      ink with paper words: the one strong action on a surface (Buy $250, Save)
 *   secondary    a quiet fill: the other way (Not now, Copy)
 *   outline      a hairline: a lesser action that still needs an edge, on a card
 *   ghost        nothing until pointed at: toolbar and row actions
 *   destructive  red: something that can't be taken back (Delete, Disconnect)
 *
 * Sizes: `sm` in rows and toolbars, `md` anywhere else, `lg` for a money card's and a dialog's
 * actions; `icon` and `icon-sm` are square. A control's corner, never a pill.
 */
const buttonVariants = cva(
  "auni-touch-target relative inline-flex shrink-0 items-center justify-center gap-2 rounded-control font-medium whitespace-nowrap transition-[background-color,color,opacity,scale] duration-150 ease-settle select-none focus-ring active:scale-[0.985] disabled:pointer-events-none disabled:opacity-50 motion-reduce:active:scale-100 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-']):not([class*='h-'])]:size-4",
  {
    variants: {
      variant: {
        primary: "bg-ink text-paper hover:bg-ink/88",
        secondary: "bg-foreground/[0.06] text-ink hover:bg-foreground/[0.1]",
        outline: "border border-border bg-transparent text-ink hover:bg-foreground/[0.04]",
        ghost: "text-muted-foreground hover:bg-foreground/[0.05] hover:text-ink",
        destructive: "bg-destructive text-paper hover:bg-destructive/90",
      },
      size: {
        sm: "h-8 px-3 text-meta",
        md: "h-10 px-4 text-ui",
        lg: "h-12 px-5 text-body",
        icon: "size-10",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

type ButtonVariants = VariantProps<typeof buttonVariants>;

function Button({
  className,
  variant = "primary",
  size = "md",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  ButtonVariants & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants, type ButtonVariants };
