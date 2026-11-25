import type * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A field's look: a box with an edge you can see, at a control's corner, that takes the focus ring
 * as it's typed in. For
 * an `<Input>`, a `<textarea>`, or anything that must look like one. (A secret the owner types
 * goes in a PrivateInput, components/private-input, which wears this too.)
 */
const inputClass =
  "h-10 w-full min-w-0 rounded-control border border-input bg-background px-3 text-ui text-ink transition-[border-color] duration-150 placeholder:text-faint focus-ring-inset disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-destructive";

function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return <input data-slot="input" type={type} className={cn(inputClass, className)} {...props} />;
}

export { Input, inputClass };
