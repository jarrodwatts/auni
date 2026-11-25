"use client";

import "./resolving-value.css";

import { useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

export function ResolvingValue({
  children,
  className,
  pending,
  placeholderClassName,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly pending: boolean;
  readonly placeholderClassName: string;
}) {
  const [wasPending, setWasPending] = useState(pending);
  if (pending && !wasPending) setWasPending(true);

  if (pending) {
    return <span aria-hidden className={cn("auni-loading-sheen block", placeholderClassName)} />;
  }

  return (
    <span className={cn("block min-w-0", wasPending && "auni-settings-value-resolve", className)}>
      {children}
    </span>
  );
}
