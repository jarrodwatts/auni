import "./skeleton.css";

import { cn } from "@/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("auni-skeleton-breath rounded-control bg-foreground/[0.06]", className)}
      {...props}
    />
  );
}

export { Skeleton };
