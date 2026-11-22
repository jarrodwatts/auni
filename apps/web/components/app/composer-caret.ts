"use client";

import { useEffect, useRef, type RefObject } from "react";

import type { MascotReadingTarget } from "@/components/brand/interactive-mascot";

const TEXT_LAYOUT_PROPERTIES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontStretch",
  "fontFeatureSettings",
  "fontVariationSettings",
  "wordBreak",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textAlign",
  "textIndent",
  "textTransform",
  "direction",
  "tabSize",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
] as const;

/** The browser lays out the same text so wrapping, emoji and bidi use its actual font metrics. */
function createComposerCaretMeasurement(input: HTMLTextAreaElement) {
  const mirror = document.createElement("div");
  const text = document.createTextNode("");
  const caret = document.createRange();
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.cssText =
    "position:fixed;left:-10000px;top:0;visibility:hidden;pointer-events:none;box-sizing:border-box;white-space:pre-wrap;overflow-wrap:break-word;border-style:solid;";
  mirror.append(text);

  return {
    measure(): MascotReadingTarget {
      if (document.activeElement !== input || input.disabled || !input.value.trim()) {
        return { active: false };
      }
      if (!mirror.isConnected) document.body.append(mirror);
      const styles = getComputedStyle(input);
      for (const property of TEXT_LAYOUT_PROPERTIES) mirror.style[property] = styles[property];
      // clientWidth excludes a classic scrollbar; its gutter also changes where text wraps.
      mirror.style.width = `${input.clientWidth + parseFloat(styles.borderLeftWidth) + parseFloat(styles.borderRightWidth)}px`;
      const position =
        input.selectionDirection === "backward" ? input.selectionStart : input.selectionEnd;
      // Keep one text node: splitting a surrogate pair or ligature changes its shaping.
      text.textContent = `${input.value}\u200b`;
      caret.setStart(text, position);
      caret.collapse(true);
      let mark = caret.getBoundingClientRect();
      // A collapsed range prefers the previous line at a soft wrap. The next
      // glyph disambiguates the start of the new line without changing shaping.
      caret.setEnd(text, position + 1);
      const nextGlyph = caret.getClientRects()[0];
      if (nextGlyph && nextGlyph.top > mark.top) mark = nextGlyph;
      const layout = mirror.getBoundingClientRect();
      const bounds = input.getBoundingClientRect();
      const x = bounds.left + mark.left - layout.left - input.scrollLeft;
      const y = bounds.top + mark.top - layout.top + mark.height / 2 - input.scrollTop;
      return {
        active: true,
        x: Math.max(bounds.left + 2, Math.min(bounds.right - 2, x)),
        y: Math.max(bounds.top + 2, Math.min(bounds.bottom - 2, y)),
      };
    },
    dispose() {
      mirror.remove();
    },
  };
}

export function useComposerCaret(
  inputRef: RefObject<HTMLTextAreaElement | null>,
  value: string,
  onActivity?: (target: MascotReadingTarget) => void,
) {
  const scheduleRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || !onActivity) return;
    const measurement = createComposerCaretMeasurement(input);
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        onActivity(measurement.measure());
      });
    };
    scheduleRef.current = schedule;
    const events = ["input", "focus", "blur", "select", "click", "keyup", "scroll"] as const;
    for (const event of events) input.addEventListener(event, schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    const resize = new ResizeObserver(schedule);
    resize.observe(input);
    schedule();
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      scheduleRef.current = null;
      for (const event of events) input.removeEventListener(event, schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      resize.disconnect();
      measurement.dispose();
      onActivity({ active: false });
    };
  }, [inputRef, onActivity]);

  useEffect(() => {
    scheduleRef.current?.();
  }, [value]);
}
