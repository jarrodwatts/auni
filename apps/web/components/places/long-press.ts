"use client";

import { useRef, type MouseEvent, type PointerEvent } from "react";

const HOLD_MS = 500;
/** A finger that moves this far is scrolling the list, not holding a row. */
const SLOP_PX = 10;

/**
 * Opens a row's menu the ways a person reaches for one: a long press on a touch screen, or a
 * right click (which a long press on Android is too). The tap that ends a long press doesn't
 * also follow the row's link. Spread the handlers on the row; give it `select-none` and
 * `[-webkit-touch-callout:none]` so iOS doesn't offer its own menu for the link.
 */
export function useLongPress(onPress: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const from = useRef({ x: 0, y: 0 });
  const pressed = useRef(false);
  const cancel = () => window.clearTimeout(timer.current);

  return {
    onPointerDown: (event: PointerEvent) => {
      pressed.current = false;
      if (event.pointerType !== "touch") return;
      from.current = { x: event.clientX, y: event.clientY };
      cancel();
      timer.current = window.setTimeout(() => {
        pressed.current = true;
        onPress();
      }, HOLD_MS);
    },
    onPointerMove: (event: PointerEvent) => {
      const moved = Math.hypot(event.clientX - from.current.x, event.clientY - from.current.y);
      if (moved > SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onClickCapture: (event: MouseEvent) => {
      if (!pressed.current) return;
      pressed.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      cancel();
      onPress();
    },
  };
}
