interface ObservedAnimation {
  readonly element: HTMLElement | SVGElement;
  intersecting: boolean;
}

const observed = new Map<Element, ObservedAnimation>();
let observer: IntersectionObserver | null = null;
let reducedMotionQuery: MediaQueryList | null = null;

function syncAnimation(entry: ObservedAnimation): void {
  const running =
    entry.intersecting &&
    document.visibilityState === "visible" &&
    !reducedMotionQuery?.matches;
  entry.element.style.setProperty("--visible-animation-state", running ? "running" : "paused");
  entry.element.style.setProperty("--visible-animation-will-change", running ? "transform" : "auto");
}

function syncAll(): void {
  for (const entry of observed.values()) syncAnimation(entry);
}

/**
 * Ref callback that runs CSS animations only while the element is on screen,
 * the tab is visible, and reduced motion is off. Paused animations keep zero
 * compositor work running for off-screen or background chats.
 */
export function observeVisibleAnimation(
  element: HTMLElement | SVGElement | null,
): (() => void) | undefined {
  if (element === null) return undefined;
  element.style.setProperty("--visible-animation-state", "paused");
  element.style.setProperty("--visible-animation-will-change", "auto");
  if (typeof IntersectionObserver === "undefined") return undefined;

  if (observer === null) {
    reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionQuery.addEventListener("change", syncAll);
    document.addEventListener("visibilitychange", syncAll);
    observer = new IntersectionObserver((entries, source) => {
      if (source !== observer) return;
      for (const hit of entries) {
        const entry = observed.get(hit.target);
        if (!entry) continue;
        entry.intersecting = hit.isIntersecting;
        syncAnimation(entry);
      }
    });
  }

  const entry: ObservedAnimation = { element, intersecting: false };
  observed.set(element, entry);
  observer.observe(element);

  return () => {
    if (observed.get(element) !== entry) return;
    observed.delete(element);
    observer?.unobserve(element);
    element.style.setProperty("--visible-animation-state", "paused");
    element.style.setProperty("--visible-animation-will-change", "auto");
    if (observed.size === 0) {
      observer?.disconnect();
      observer = null;
      reducedMotionQuery?.removeEventListener("change", syncAll);
      reducedMotionQuery = null;
      document.removeEventListener("visibilitychange", syncAll);
    }
  };
}
