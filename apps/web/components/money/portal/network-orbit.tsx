"use client";

import "./orbit.css";

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

import type { DepositNetwork } from "@/lib/data/portfolio";
import { REDUCED_MOTION } from "@/lib/use-viewport";

import { NetworkMark } from "./network-mark";

/** One turn of the orbit takes this long, left to itself. */
const TURN_MS = 64_000;
/** How quickly the orbit swings an address's networks round to the front: its time constant. */
const SWING_MS = 240;
/** Where a mark is nearest, in the orbit's own angles: straight in front of Auni. */
const FRONT = 90;
/** Where the orbit starts: the first network, Monad, in front. */
const START = FRONT;

/** What the orbit shows of a network: its mark, and its name when pointed at. */
type OrbitNetwork = Pick<DepositNetwork, "key" | "logo" | "networkName">;

export interface OrbitProps {
  readonly networks: readonly OrbitNetwork[];
  /** The networks of the address in hand, lit as the rest dim. */
  readonly lit?: readonly OrbitNetwork[] | null;
  /** The network money just landed on: its mark lights and travels into Auni. */
  readonly arriving?: DepositNetwork["key"] | null;
  /** Holds the orbit where it is, as a code shows over it. */
  readonly still?: boolean;
}

/**
 * Every network Add money takes, as its mark on a tilted orbit round Auni's middle, Monad's the
 * largest: fainter at the back, hidden as it passes behind Auni. An address in hand (pointed at or copied)
 * swings its networks round to the front and lights them as the rest dim. Pointing at a mark, or
 * tapping it, names it. Money landing lights its network's mark, where it stays.
 */
export function NetworkOrbit({ networks, lit = null, arriving = null, still = false }: OrbitProps) {
  const [named, setNamed] = useState<string | null>(null);
  const orbit = useRef<HTMLDivElement>(null);
  const n = networks.length;
  const angle = (index: number) => (index * 360) / n;
  const litKeys = lit ? new Set(lit.map(({ key }) => key)) : null;
  const front = litKeys
    ? meanAngle(
        networks.flatMap((network, index) => (litKeys.has(network.key) ? [angle(index)] : [])),
      )
    : null;
  useOrbit(orbit, { front, turning: !still && !named && !arriving });
  return (
    <div
      ref={orbit}
      aria-hidden
      className="auni-orbit"
      data-arriving={arriving ? "" : undefined}
      data-lit={litKeys ? "" : undefined}
      style={{ "--auni-orbit-spin": `${START}deg` } as CSSProperties}
    >
      <span className="auni-orbit-line auni-orbit-back" />
      <span className="auni-orbit-line auni-orbit-front" />
      {networks.map((network, index) => (
        <span
          key={network.key}
          className="auni-orbit-at"
          data-arrive={arriving === network.key ? "" : undefined}
          data-lit={litKeys?.has(network.key) ? "" : undefined}
          data-named={named === network.key ? "" : undefined}
          style={{ "--a": `${angle(index)}deg`, "--mark": `${markSize(index)}px` } as CSSProperties}
          onClick={() => setNamed(named === network.key ? null : network.key)}
          onPointerEnter={(event) => {
            if (event.pointerType === "mouse") setNamed(network.key);
          }}
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") setNamed(null);
          }}
        >
          <span className="auni-orbit-mark">
            <NetworkMark className="auni-orbit-disc" network={network} size={markSize(index)} />
          </span>
          <span className="auni-orbit-name">{network.networkName}</span>
        </span>
      ))}
    </div>
  );
}

/**
 * Two sizes on the orbit: the first network, Monad, the one Auni is built around, a size up from
 * the rest, which all match wherever they are on it.
 */
const markSize = (index: number) => (index === 0 ? 36 : 26);

/** The middle of some angles round a circle, in degrees: where a group of marks is centred. */
function meanAngle(angles: readonly number[]): number {
  const [x, y] = angles.reduce(
    ([sx, sy], a) => [sx + Math.cos((a * Math.PI) / 180), sy + Math.sin((a * Math.PI) / 180)],
    [0, 0],
  );
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/**
 * Turns the orbit by setting its --auni-orbit-spin each frame: slowly round while `turning`, or
 * swung (eased, the short way) until the angle `front` is in front. Where motion is reduced it
 * stays where it is.
 */
function useOrbit(
  orbit: RefObject<HTMLDivElement | null>,
  { front, turning }: { readonly front: number | null; readonly turning: boolean },
) {
  const spin = useRef(START);
  useEffect(() => {
    const element = orbit.current;
    if (!element || window.matchMedia(REDUCED_MOTION).matches) return;
    if (front === null && !turning) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const step = Math.min(now - last, 64);
      last = now;
      let settled = false;
      if (front !== null) {
        const gap = ((((FRONT - front - spin.current) % 360) + 540) % 360) - 180;
        spin.current += gap * (1 - Math.exp(-step / SWING_MS));
        settled = Math.abs(gap) < 0.05;
      } else {
        spin.current += (360 * step) / TURN_MS;
      }
      element.style.setProperty("--auni-orbit-spin", `${spin.current % 360}deg`);
      // Swung round, it rests there until the address is let go.
      if (!settled) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [front, orbit, turning]);
}
