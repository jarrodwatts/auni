"use client";

import { QrCode } from "lucide-react";
import { useLayoutEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";

import { MascotArt } from "@/components/brand/mascot-art";
import { LogoImage } from "@/components/brand/marks";
import { REDUCED_MOTION } from "@/lib/use-viewport";
import { cn } from "@/lib/utils";

import {
  networkNames,
  networksInBrief,
  shortAddress,
  type DepositAddress,
} from "./deposit-addresses";
import { NetworkMark } from "./network-mark";
import { NetworkOrbit, type OrbitProps } from "./network-orbit";

// What the Portal and the chat's deposit card share: Auni waiting over its glow in its orbit of
// networks, and the addresses under it. Each sits inside an `.auni-portal`, whose data attributes set its states.

/** Auni nods when an address is copied, squashing from its feet. */
export const NOD: Keyframe[] = [
  { transform: "none" },
  { offset: 0.3, transform: "translateY(-9px) scale(0.97, 1.04)" },
  { offset: 0.6, transform: "scale(1.04, 0.96)" },
  { transform: "none" },
];
const HOP: Keyframe[] = [
  { transform: "none" },
  { offset: 0.14, transform: "scale(1.1, 0.88)" },
  { offset: 0.42, transform: "translateY(-28px) scale(0.94, 1.08)" },
  { offset: 0.64, transform: "scale(1.08, 0.92)" },
  { offset: 0.8, transform: "scale(0.98, 1.02)" },
  { transform: "none" },
];
/** How long a landed network's coin takes to fly into Auni's mouth, before Auni hops. */
export const ARRIVE_MS = 1_000;
/**
 * The gulp, from the moment the money lands: Auni stretches up toward the coin as it opens wide,
 * squashes flat as it swallows (ARRIVE_MS in), then the hop.
 */
const GULP_MS = ARRIVE_MS + 1_000;
const at = (ms: number) => ms / GULP_MS;
const GULP: Keyframe[] = [
  { transform: "none" },
  { offset: at(300), transform: "scale(0.97, 1.05)" },
  { offset: at(880), transform: "translateY(-6px) scale(0.92, 1.12)" },
  { offset: at(1_000), transform: "translateY(2px) scale(1.22, 0.8)" },
  { offset: at(1_140), transform: "scale(1.12, 0.88)" },
  { offset: at(1_420), transform: "translateY(-30px) scale(0.94, 1.08)" },
  { offset: at(1_640), transform: "scale(1.08, 0.92)" },
  { offset: at(1_800), transform: "scale(0.98, 1.02)" },
  { transform: "none" },
];

/**
 * Auni, as money lands: with a coin on its way (`arriving`), the gulp, else a hop.
 * Returns what stops it.
 */
export function landOn(body: HTMLElement | null, arriving: boolean): () => void {
  if (!body || window.matchMedia(REDUCED_MOTION).matches) return () => {};
  const moving = arriving
    ? body.animate(GULP, { duration: GULP_MS, easing: "ease-in-out" })
    : body.animate(HOP, { duration: 1_000, easing: "ease-in-out" });
  return () => moving.cancel();
}
/** The amount starts counting once the hop has lifted Auni, and settles as Auni does. */
export const COUNT_DELAY_MS = 380;
export const COUNT_UP_MS = 900;

/** Where Auni moves, played on the element unless motion is reduced. */
export function play(element: HTMLElement | null, keyframes: Keyframe[], durationMs: number) {
  if (!element || window.matchMedia(REDUCED_MOTION).matches) return;
  element.animate(keyframes, { duration: durationMs, easing: "ease-in-out" });
}

/** The bits that burst out of Auni once it has gulped the money down, each its own way. */
const BURST = Array.from({ length: 12 }, (_, index) => index);

/** The coins Auni has art for, by the symbol that arrived. */
const COINS: Readonly<Record<string, string>> = {
  USDC: "/brand/tokens/usdc.svg",
  MON: "/brand/tokens/mon.png",
  SOL: "/brand/tokens/sol.png",
  BTC: "/brand/tokens/btc.svg",
  POL: "/brand/tokens/pol.png",
  ETH: "/brand/chains/ethereum.svg",
};

/** The coin, and the fading copies of it that trail behind, drawing its path. */
const COIN_TRAIL = [0, 1, 2, 3] as const;
/** The coin leaves its address as Auni starts to open, and is in its mouth as it shuts. */
const COIN_DELAY_MS = 140;
const COIN_FLIGHT_MS = 840;

/**
 * Auni floating over its glow and its shadow, with happy eyes ready for a landing, inside the
 * orbit of every network it takes money on. Money landing, Auni opens wide and gulps it down: a
 * coin of what arrived (`coin`, its symbol: USDC's own, or its network's mark for a coin Auni has
 * no art for) flies out of its network's place on the orbit, along an arc that its trail draws,
 * and into Auni's mouth as it shuts, then a burst. `body` is what NOD and HOP move; whatever else
 * is given sits over the glow, under Auni.
 */
export function PortalHero({
  body,
  children,
  className,
  coin: arrived = null,
  hero,
  orbit,
}: {
  readonly body: RefObject<HTMLSpanElement | null>;
  readonly children?: ReactNode;
  readonly className?: string;
  /** The symbol of what arrived, while it does. */
  readonly coin?: string | null;
  /** What useGaze sets Auni's eyes on. */
  readonly hero: RefObject<HTMLDivElement | null>;
  readonly orbit: OrbitProps;
}) {
  // A ring says "any of these": with a single network there is nothing to choose from, so Auni
  // stands alone and the line under it names the one (see DepositCard).
  const ringed = orbit.networks.length > 1;
  const arriving = orbit.networks.find(({ key }) => key === orbit.arriving) ?? null;
  const coin = useRef<HTMLSpanElement>(null);
  useCoinFlight(coin, arriving?.key ?? null);
  return (
    <div className={cn("auni-portal-stage", className)} data-ringed={ringed ? "" : undefined}>
      {ringed ? <NetworkOrbit {...orbit} /> : null}
      <div ref={hero} className="auni-portal-hero">
        <span aria-hidden className="auni-portal-glow" />
        <span aria-hidden className="auni-portal-ring" />
        <span aria-hidden className="auni-portal-shadow" />
        {children}
        <span aria-hidden className="auni-portal-pos">
          <span className="auni-portal-float">
            <span ref={body} className="auni-portal-squash">
              <MascotArt joy mouth />
            </span>
          </span>
        </span>
        {arriving ? (
          <span ref={coin} aria-hidden className="auni-portal-coin">
            {COIN_TRAIL.map((step) => (
              <span key={step} className="auni-portal-coin-step" data-step={step}>
                <LogoImage
                  src={(arrived && COINS[arrived.toUpperCase()]) ?? null}
                  size={64 - step * 10}
                  fallback={<NetworkMark network={arriving} size={64 - step * 10} />}
                  className="rounded-full"
                />
              </span>
            ))}
          </span>
        ) : null}
        <span aria-hidden className="auni-portal-burst">
          {BURST.map((index) => (
            <i
              key={index}
              style={{ "--i": index, "--reach": `${64 + (index % 3) * 22}px` } as CSSProperties}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

/**
 * Flies the coin out of its network's place on the orbit (or, with no orbit, the networks' marks
 * on the address the money came to), along an arc, into Auni's mouth, where it sits: each copy
 * behind it a beat later and fainter, so the path shows. Where motion is reduced it doesn't fly;
 * the money simply lands.
 */
function useCoinFlight(coin: RefObject<HTMLSpanElement | null>, arriving: string | null) {
  useLayoutEffect(() => {
    const element = coin.current;
    if (!element || !arriving || window.matchMedia(REDUCED_MOTION).matches) return undefined;
    const portal = element.closest(".auni-portal");
    const from =
      portal?.querySelector(".auni-orbit-at[data-arrive] .auni-orbit-mark") ??
      portal?.querySelector(`[data-networks~="${arriving}"] [data-slot="network-stack"]`);
    if (!from) return undefined;
    const start = from.getBoundingClientRect();
    const end = element.getBoundingClientRect();
    const dx = start.left + start.width / 2 - (end.left + end.width / 2);
    const dy = start.top + start.height / 2 - (end.top + end.height / 2);
    // A quadratic curve that rises beside the address first, then sweeps over into the mouth.
    const bend = { x: dx * 1.1, y: Math.min(dy, 0) * 0.6 - 130 };
    const at = (t: number) => ({
      x: (1 - t) ** 2 * dx + 2 * (1 - t) * t * bend.x,
      y: (1 - t) ** 2 * dy + 2 * (1 - t) * t * bend.y,
    });
    const frames: Keyframe[] = Array.from({ length: 13 }, (_, index) => {
      const t = index / 12;
      const { x, y } = at(t);
      return {
        offset: t,
        opacity: t === 0 ? 0 : t > 0.94 ? 0 : 1,
        transform: `translate(${x}px, ${y}px) scale(${1 - 0.5 * t ** 2}) rotate(${-320 * t}deg)`,
      };
    });
    const flights = [...element.children].map((step, index) =>
      step.animate(frames, {
        delay: COIN_DELAY_MS + index * 45,
        duration: COIN_FLIGHT_MS,
        easing: "cubic-bezier(0.4, 0, 0.3, 1)",
        fill: "both",
      }),
    );
    return () => flights.forEach((flight) => flight.cancel());
  }, [coin, arriving]);
}

/** How many of an address's networks its row shows as marks, overlapping, the first in front. */
const STACKED = 2;

/**
 * Which networks an address is for, at a glance: their marks overlapping like a hand of cards,
 * the first (Auni's own Monad, for the EVM address) in front; the line beside names them.
 */
function NetworkStack({ networks }: { readonly networks: DepositAddress["networks"] }) {
  const shown = networks.slice(0, STACKED);
  return (
    <span aria-hidden className="flex items-center" data-slot="network-stack">
      {shown.map((network, index) => (
        <NetworkMark
          key={network.key}
          network={network}
          size={26}
          className={cn("relative ring-2 ring-card", index > 0 && "-ml-2.5")}
          style={{ zIndex: shown.length - index }}
        />
      ))}
    </span>
  );
}

/** The card the address rows sit on, a hairline between each. */
// The rows share their columns, so every address starts at one edge, after the widest stack.
export const addressRowsClass =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] divide-y divide-border overflow-hidden rounded-[18px] bg-card text-left shadow-[0_0_0_1px_var(--border),0_4px_14px_--alpha(var(--color-shade-blue)/6%)]";

/** The height and shape of a row's buttons: its code's and Copy. */
const chipClass =
  "grid h-9 flex-none place-items-center rounded-full outline-none transition-colors duration-200 focus-visible:ring-[3px] focus-visible:ring-ring/35";

/**
 * One address: its networks' marks and names, its ends, then its code's button and Copy side by
 * side, Copy in the accent since it's what most people do. Its networks also light on the orbit
 * above while the row is pointed at, focused or copied. With its code open, the code's button fills and the
 * row takes a faint tint.
 */
export function AddressRow({
  blocked,
  copied,
  entry,
  on = false,
  onCopy,
  onPoint,
  onToggleQr,
}: {
  /** The browser refused to copy, so the whole address shows, to be selected by hand. */
  readonly blocked: boolean;
  readonly copied: boolean;
  readonly entry: DepositAddress;
  readonly on?: boolean;
  readonly onCopy: () => void;
  /** The row taken in hand (pointed at by a mouse, or focused), or let go of. */
  readonly onPoint?: (inHand: boolean) => void;
  /** Absent where no code is shown, which leaves the row its Copy button alone. */
  readonly onToggleQr?: () => void;
}) {
  const names = networkNames(entry.networks);
  return (
    <div
      className="col-span-full grid min-h-[60px] grid-cols-subgrid items-center gap-x-3 py-2.5 pr-3 pl-4 transition-colors duration-250 data-on:bg-primary/[0.04]"
      data-on={on ? "" : undefined}
      data-networks={entry.networks.map(({ key }) => key).join(" ")}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") onPoint?.(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === "mouse") onPoint?.(false);
      }}
      onFocus={() => onPoint?.(true)}
      onBlur={() => onPoint?.(false)}
    >
      <NetworkStack networks={entry.networks} />
      <span className="min-w-0">
        <span
          className={cn(
            "block text-[15px] leading-5 font-semibold whitespace-nowrap text-ink tabular-nums",
            blocked && "font-mono text-[13px] break-all whitespace-normal select-all",
          )}
        >
          {blocked ? entry.address : shortAddress(entry.address)}
        </span>
        <span className="block truncate text-[12.5px] leading-[18px] text-muted-foreground">
          {networksInBrief(entry.networks)}
        </span>
      </span>
      <span className="flex items-center gap-2">
        {onToggleQr ? (
          <button
            type="button"
            aria-label={`QR code for your ${names} address`}
            aria-pressed={on}
            onClick={onToggleQr}
            className={cn(
              chipClass,
              "w-9 bg-foreground/[0.05] text-muted-foreground hover:bg-primary/[0.1] hover:text-primary aria-pressed:bg-primary aria-pressed:text-background",
            )}
          >
            <QrCode aria-hidden className="size-[17px]" />
          </button>
        ) : null}
        <button
          type="button"
          aria-label={`Copy your ${names} address`}
          onClick={onCopy}
          className={cn(
            chipClass,
            "px-3.5 text-[14px] font-semibold",
            copied
              ? "bg-positive/[0.12] text-positive"
              : "bg-primary/[0.08] text-primary hover:bg-primary/[0.13]",
          )}
        >
          {/* Both words share one cell, so the button never changes width. */}
          <span className={cn("[grid-area:1/1]", copied && "invisible")}>Copy</span>
          <span className={cn("[grid-area:1/1]", !copied && "invisible")}>Copied</span>
        </button>
      </span>
    </div>
  );
}

/** A row's shape while its address is on its way. */
export function RowSkeleton() {
  return (
    <div
      aria-hidden
      className="col-span-full grid h-[60px] grid-cols-subgrid items-center gap-x-3 pr-3 pl-4"
    >
      <span className="auni-loading-sheen size-[26px] rounded-full" />
      <span>
        <span className="auni-loading-sheen block h-3 w-28 rounded-full" />
      </span>
      <span className="flex items-center gap-2">
        <span className="auni-loading-sheen size-9 rounded-full" />
        <span className="auni-loading-sheen h-9 w-[68px] rounded-full" />
      </span>
    </div>
  );
}
