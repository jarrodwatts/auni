// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { Disclosure, JumpedTo, Setting, type Jump } from "./settings-layout";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const draw = (jump: Jump | null, inner = true) =>
  act(() =>
    root.render(
      <JumpedTo.Provider value={jump}>
        <Disclosure id="setting-developers" title="For developers" holds={["setting-networks"]}>
          {inner ? (
            <Setting id="setting-networks" label="Networks">
              <input aria-label="Alchemy key" />
            </Setting>
          ) : null}
        </Disclosure>
      </JumpedTo.Provider>,
    ),
  );
const toggle = () => host.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
const field = () => host.querySelector<HTMLInputElement>("input");

// A search for Alchemy opened "For developers" only while its flash showed: 2.4 s later it
// closed, and the key half-typed into it was gone (2026-11-25).
it("stays open after a search's flash fades, keeping what was typed", () => {
  const landed: Jump = { n: 1, target: "setting-networks", lit: true };
  draw(landed);
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  field()!.value = "alch-key-half";
  const typedInto = field();

  draw({ ...landed, lit: false });
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
  expect(field()).toBe(typedInto);
  expect(field()!.value).toBe("alch-key-half");
});

// While the flash showed, its toggle couldn't close it.
it("closes when the owner says, flash or not, and opens again on the next search", () => {
  const landed: Jump = { n: 1, target: "setting-networks", lit: true };
  draw(landed);
  act(() => toggle().click());
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  draw({ ...landed, lit: false });
  expect(toggle().getAttribute("aria-expanded")).toBe("false");

  draw({ n: 2, target: "setting-networks", lit: true });
  expect(toggle().getAttribute("aria-expanded")).toBe("true");
});

// A pane that draws its setting once its data is in drew it after the one scroll had run.
it("scrolls to where a search landed once it's drawn, once", () => {
  const scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  const landed: Jump = { n: 1, target: "setting-networks", lit: true };
  draw(landed, false);
  const scrolledTo = () => scroll.mock.contexts.map((element) => (element as HTMLElement).id);
  expect(scrolledTo()).toEqual([]);

  draw(landed, true);
  expect(scrolledTo()).toEqual(["setting-networks"]);
  draw({ ...landed, lit: false }, true);
  expect(scrolledTo()).toEqual(["setting-networks"]);
});
