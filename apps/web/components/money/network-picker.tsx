"use client";

import type { NetworkKey } from "@auni/shared";
import { useState } from "react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { NetworkMark } from "./portal/network-mark";

/** A network as the picker shows it: its mark and its name. */
export interface PickedNetwork {
  readonly key: NetworkKey;
  readonly name: string;
  readonly logo: string;
}

/**
 * Which network money goes over, as chips with each network's own mark: the one step where a
 * wrong pick costs money, so the choice is always in view. `more` are networks offered behind a
 * "more" chip, shown once it's pressed or one of them is picked.
 */
export function NetworkPicker({
  label,
  networks,
  more = [],
  value,
  onChange,
  className,
}: {
  /** What the group is for, for a screen reader: "Network to send on". */
  readonly label: string;
  readonly networks: readonly PickedNetwork[];
  readonly more?: readonly PickedNetwork[];
  readonly value: NetworkKey;
  readonly onChange: (key: NetworkKey) => void;
  readonly className?: string;
}) {
  const [opened, setOpened] = useState(false);
  const showMore = opened || more.some(({ key }) => key === value);
  const shown = showMore ? [...networks, ...more] : networks;
  return (
    <div role="radiogroup" aria-label={label} className={cn("flex flex-wrap gap-2", className)}>
      {shown.map((network) => {
        const on = network.key === value;
        return (
          <button
            key={network.key}
            type="button"
            role="radio"
            aria-checked={on}
            data-networks={network.key}
            onClick={() => onChange(network.key)}
            className={cn(
              buttonVariants({ variant: "outline", size: "sm" }),
              "h-9 gap-2 pr-3 pl-1.5 text-ui",
              on ? "border-ink bg-foreground/[0.04]" : "text-muted-foreground hover:text-ink",
            )}
          >
            <span data-slot="network-stack" className="flex">
              <NetworkMark network={network} size={24} />
            </span>
            {network.name}
          </button>
        );
      })}
      {more.length > 0 && !showMore ? (
        <button
          type="button"
          onClick={() => setOpened(true)}
          className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "h-9 text-ui")}
        >
          {more.length} more
        </button>
      ) : null}
    </div>
  );
}
