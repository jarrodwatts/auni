import type { DoctorFindingWire } from "@auni/shared";
import { describe, expect, it } from "vitest";

import { chatLinks, healthOf, partName } from "./health";

const finding = (check: string, status: DoctorFindingWire["status"]): DoctorFindingWire => ({
  check,
  status,
  says: `${check} ${status}`,
  repair: null,
  chats: [],
  heldMove: null,
});

describe("Health, as the owner reads it", () => {
  it("leads with whether anything needs them, and lists only that", () => {
    expect(healthOf([finding("rpc", "ok"), finding("always-on", "note")])).toEqual({
      headline: "Everything's working",
      needs: [],
    });
    const two = healthOf([finding("runner", "fix"), finding("rpc", "ok"), finding("brain", "fix")]);
    expect(two.headline).toBe("2 things need you");
    expect(two.needs.map(({ check }) => check)).toEqual(["runner", "brain"]);
    expect(healthOf([finding("brain", "fix")]).headline).toBe("1 thing needs you");
  });

  it("names each part in the owner's words", () => {
    expect(partName("rpc")).toBe("Networks");
    expect(partName("brain")).toBe("Your AI");
    expect(partName("something-new")).toBe("something-new");
  });

  // With held moves in two chats, Health linked only the first (2026-11-25).
  it("links every chat holding a card the owner needs to check", () => {
    expect(chatLinks([])).toEqual([]);
    expect(chatLinks([{ id: "t1", title: "Fed bet" }])).toEqual([
      { href: "/app/chat/t1", label: "Open chat" },
    ]);
    expect(
      chatLinks([
        { id: "t1", title: "Take a little off my Fed bet" },
        { id: "t2", title: null },
      ]),
    ).toEqual([
      { href: "/app/chat/t1", label: "Open Take a little off my Fed bet" },
      { href: "/app/chat/t2", label: "Open untitled chat" },
    ]);
  });
});
