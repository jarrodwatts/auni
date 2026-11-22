"use client";

import { Popover } from "radix-ui";

import type { DepositNetwork } from "@/lib/data/portfolio";

import { NetworkMark } from "./network-mark";

/**
 * A network named as a thing, not a word: its mark and name in a pill. A tap (or a pointer
 * resting on it) says what the name means where it counts, on the exchange or wallet's own
 * "which network?" step, since a wrong pick there is the one way money goes astray.
 */
export function NetworkChip({ network }: { readonly network: DepositNetwork }) {
  return (
    <Popover.Root>
      <Popover.Trigger
        className="ml-1 inline-flex h-7 translate-y-[-1px] items-center gap-1.5 rounded-full bg-foreground/[0.05] py-0 pr-3 pl-1 align-middle text-[14px] font-semibold text-ink shadow-[inset_0_0_0_1px_var(--border)] outline-none transition-colors duration-150 hover:bg-foreground/[0.08] focus-visible:ring-[3px] focus-visible:ring-ring/35"
        aria-label={`${network.networkName}: what this means`}
      >
        <NetworkMark network={network} size={20} />
        {network.networkName}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          sideOffset={8}
          collisionPadding={16}
          className="z-50 w-[260px] outline-none origin-(--radix-popover-content-transform-origin) animate-in rounded-[16px] bg-popover p-4 text-left text-popover-foreground shadow-[0_0_0_1px_var(--border),0_12px_32px_--alpha(var(--color-shade-blue)/14%)] fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95"
        >
          <div className="flex items-center gap-2.5">
            <NetworkMark network={network} size={28} />
            <p className="text-[15px] font-semibold text-ink">{network.networkName}</p>
          </div>
          <p className="mt-2.5 text-[13.5px] leading-[20px] text-muted-foreground">
            When your exchange or wallet asks which network, pick {network.networkName}. That&apos;s
            where I&apos;m watching for it.
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
