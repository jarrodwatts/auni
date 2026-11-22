"use client";

import { useEffect, useState } from "react";

/**
 * A holding's own colors, read from its logo: the dominant brand hue, and a
 * second hue when the mark has one (Solana's purple and teal). Always solid,
 * never faded toward white. Black-and-white marks read as slate.
 */
export interface BrandColors {
  readonly from: string;
  readonly to: string;
}

/** A color's hue in degrees, with its saturation and lightness from 0 to 1. */
function hsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b) / 255;
  const min = Math.min(r, g, b) / 255;
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const h =
    max === rr
      ? ((gg - bb) / d + (gg < bb ? 6 : 0)) * 60
      : max === gg
        ? ((bb - rr) / d + 2) * 60
        : ((rr - gg) / d + 4) * 60;
  return [h, s, l];
}

const SLATE: BrandColors = { from: "var(--muted-foreground)", to: "var(--muted-foreground)" };
const cache = new Map<string, Promise<BrandColors | null>>();

const rgb = (bucket: { r: number; g: number; b: number; n: number }) =>
  `rgb(${Math.round(bucket.r / bucket.n)} ${Math.round(bucket.g / bucket.n)} ${Math.round(bucket.b / bucket.n)})`;

/** A mark's main hue and saturation (0 to 1); null for a black-and-white one, which reads as slate. */
export function brandHue(colors: BrandColors): { readonly h: number; readonly s: number } | null {
  const channels = /^rgb\((\d+) (\d+) (\d+)\)$/u.exec(colors.from)?.slice(1).map(Number);
  if (!channels) return null;
  const [h, s] = hsl(channels[0]!, channels[1]!, channels[2]!);
  return { h, s };
}

/** Reads through the image optimizer: same origin, so the canvas stays readable under the CSP. */
function optimized(src: string): string {
  return src.startsWith("/") && !src.startsWith("/_next/")
    ? src
    : `/_next/image?url=${encodeURIComponent(src)}&w=64&q=75`;
}

function extract(src: string): Promise<BrandColors | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onerror = () => resolve(null);
    image.onload = () => {
      try {
        const size = 40;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) return resolve(null);
        context.drawImage(image, 0, 0, size, size);
        const { data } = context.getImageData(0, 0, size, size);
        const buckets = Array.from({ length: 24 }, (_, index) => ({
          hue: index * 15,
          weight: 0,
          r: 0,
          g: 0,
          b: 0,
          n: 0,
        }));
        let counted = 0;
        let chromatic = 0;
        for (let i = 0; i < data.length; i += 4) {
          const [r, g, b, a] = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
          if (a < 200) continue;
          const [h, s, l] = hsl(r, g, b);
          if (l > 0.93) continue;
          counted++;
          if (s < 0.25 || l < 0.12) continue;
          chromatic++;
          const bucket = buckets[Math.floor(h / 15) % 24]!;
          bucket.weight += s;
          bucket.r += r;
          bucket.g += g;
          bucket.b += b;
          bucket.n++;
        }
        if (counted === 0 || chromatic / counted < 0.08) return resolve(SLATE);
        const ranked = buckets.filter((bucket) => bucket.n > 0).sort((a, b) => b.weight - a.weight);
        const top = ranked[0]!;
        const second = ranked.find(
          (bucket) =>
            bucket.weight >= top.weight * 0.22 &&
            Math.min(Math.abs(bucket.hue - top.hue), 360 - Math.abs(bucket.hue - top.hue)) >= 45,
        );
        resolve({ from: rgb(top), to: rgb(second ?? top) });
      } catch {
        resolve(null);
      }
    };
    image.src = optimized(src);
  });
}

/** Null until read, or when the mark can't be read (an SVG, a failed load). */
export function useBrandColors(src: string | null | undefined): BrandColors | null {
  // Kept with the src it was read from, so a changed or cleared logo never shows the last one's colors.
  const [read, setRead] = useState<{ readonly src: string; readonly colors: BrandColors | null }>();
  useEffect(() => {
    if (!src) return;
    let live = true;
    if (!cache.has(src)) cache.set(src, extract(src));
    void cache.get(src)!.then((colors) => {
      if (live) setRead({ src, colors });
    });
    return () => {
      live = false;
    };
  }, [src]);
  return src && read?.src === src ? read.colors : null;
}
