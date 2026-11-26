import { NETWORKS, type WithdrawNetwork } from "@auni/shared";
import { Landmark, MapPin, Wallet } from "lucide-react";

import { NetworkMark } from "@/components/money/portal/network-mark";
import type { WithdrawDestination } from "@/lib/data/withdrawals";

/** Whose a place is, drawn plainly: Auni never knows which exchange, so it's no one's logo. */
const GLYPHS = { exchange: Landmark, wallet: Wallet } as const;

/**
 * Where a withdrawal goes, as a mark: whose it is (their exchange, their other wallet, or just an
 * address), with the network it's on as a small badge, so a network's logo never stands for the
 * exchange itself.
 */
export function PlaceMark({
  destination,
  network,
  size,
}: {
  readonly destination: WithdrawDestination | null;
  readonly network: WithdrawNetwork;
  readonly size: number;
}) {
  const Glyph = destination ? GLYPHS[destination] : MapPin;
  const badge = Math.round(size * 0.45);
  return (
    <span className="relative flex-none" style={{ width: size, height: size }}>
      <span className="grid size-full place-items-center rounded-full bg-foreground/[0.06] text-ink">
        <Glyph aria-hidden size={Math.round(size * 0.45)} />
      </span>
      <NetworkMark
        className="absolute -right-1 -bottom-1 ring-2 ring-popover"
        network={{ key: network, logo: NETWORKS[network].logo }}
        size={badge}
      />
    </span>
  );
}
