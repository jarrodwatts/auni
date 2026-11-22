"use client";

import { useEffect, type RefObject } from "react";

/** How far Auni's eyes reach, in its artwork's units: across, and up or down. */
const REACH = [13, 11] as const;
/** From this far out, in pixels, Auni looks with its eyes' full reach. */
const FULL_REACH_PX = 160;
/** How long Auni keeps looking where a finger tapped. */
const TAP_LOOK_MS = 1_500;

/**
 * While `on`, Auni's eyes follow the pointer; over something to tap, or on it by keyboard, they
 * glance at it instead, and on a touch screen at what a finger taps. Set as CSS variables on
 * `hero`, which the face reads (see .auni-mascot-face), so nothing re-renders. Still where
 * motion is reduced.
 */
export function useGaze(hero: RefObject<HTMLElement | null>, on: boolean): void {
  useEffect(() => {
    const root = hero.current;
    if (!root) return;
    const set = (x: number, y: number) => {
      root.style.setProperty("--auni-eye-x", `${x.toFixed(2)}px`);
      root.style.setProperty("--auni-eye-y", `${y.toFixed(2)}px`);
    };
    const rest = () => set(0, 0);
    if (!on) return rest();

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const look = (x: number, y: number) => {
      if (reduced.matches) return;
      const box = root.getBoundingClientRect();
      const dx = x - (box.left + box.width / 2);
      const dy = y - (box.top + box.height * 0.45);
      const distance = Math.hypot(dx, dy);
      const reach = distance === 0 ? 0 : Math.min(1, distance / FULL_REACH_PX) / distance;
      set(dx * reach * REACH[0], dy * reach * REACH[1]);
    };
    // A button in the dialog, which Auni glances at the middle of rather than at the pointer.
    const controlAt = (target: EventTarget | null) => {
      const control = target instanceof Element ? target.closest("button") : null;
      return control && root.closest("[role=dialog]")?.contains(control) ? control : null;
    };
    const glance = (target: EventTarget | null, x: number, y: number) => {
      const control = controlAt(target);
      if (!control) return look(x, y);
      const box = control.getBoundingClientRect();
      look(box.left + box.width / 2, box.top + box.height / 2);
    };

    let frame: number | null = null;
    let tapped: ReturnType<typeof setTimeout> | undefined;
    const move = (event: PointerEvent) => {
      if (event.pointerType === "touch" || frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        glance(event.target, event.clientX, event.clientY);
      });
    };
    const down = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      glance(event.target, event.clientX, event.clientY);
      clearTimeout(tapped);
      tapped = setTimeout(rest, TAP_LOOK_MS);
    };
    const focus = (event: FocusEvent) => {
      const control = controlAt(event.target);
      if (control?.matches(":focus-visible")) glance(control, 0, 0);
    };

    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", down, { passive: true });
    document.addEventListener("focusin", focus);
    document.documentElement.addEventListener("pointerleave", rest);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down);
      document.removeEventListener("focusin", focus);
      document.documentElement.removeEventListener("pointerleave", rest);
      if (frame !== null) cancelAnimationFrame(frame);
      clearTimeout(tapped);
      rest();
    };
  }, [hero, on]);
}
