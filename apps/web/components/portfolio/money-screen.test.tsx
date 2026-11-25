import type { ActivityItemWire, ThreadId } from "@auni/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Take } from "@/lib/data/takes";

import { MoneyScreen } from "./money-screen";

const TAKE = "00000000-0000-4000-8000-00000000000a" as ThreadId;

const move = (id: string, title: string, threadId: string | null = null) =>
  ({
    id,
    kind: "move",
    title,
    amount: null,
    threadId,
    at: "2026-11-20T00:00:00.000Z",
  }) as ActivityItemWire;

/** What each read answers in a test: the account's moves, each take's own, balances and takes. */
const reads = vi.hoisted(() => ({
  everything: [] as ActivityItemWire[],
  byTake: new Map<string, ActivityItemWire[]>(),
  balancesFailed: false,
  takes: [] as Take[],
}));

vi.mock("@/components/activity/use-activity", () => ({
  useActivity: (only: string | null = null) => ({
    data: { items: only === null ? reads.everything : (reads.byTake.get(only) ?? []), unread: 0 },
  }),
}));
vi.mock("./use-portfolio", () => ({
  usePortfolio: () =>
    reads.balancesFailed ? { isError: true, data: undefined, refetch: () => {} } : { data: {} },
  useTakes: () => ({ data: { takes: reads.takes, cash: [], loose: [] } }),
}));
vi.mock("@/components/money/money-provider", () => ({
  useMoney: () => ({
    loading: false,
    portfolio: reads.balancesFailed ? undefined : { empty: false },
  }),
}));
vi.mock("@/components/places/place-header", () => ({ PlaceHeader: () => <h1>Money</h1> }));
vi.mock("@/components/places/use-places", () => ({
  usePlaces: () => ({ chats: [], archived: [] }),
}));
vi.mock("@/components/places/open-place", () => ({
  PlaceLink: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));
vi.mock("@/components/app/use-start-conversation", () => ({ useStartNew: () => undefined }));
vi.mock("@/components/app/app-dialogs", () => ({ useAppDialogs: () => ({ addMoneyHref: "/" }) }));
vi.mock("./total-hero", () => ({ TotalHero: () => <p>Your money</p> }));
vi.mock("./holding-groups", () => ({ CashGroup: () => null, OtherHoldings: () => null }));
vi.mock("./recent", () => ({
  Recent: ({ activity }: { activity: { data: { items: ActivityItemWire[] } } }) => (
    <ul>
      {activity.data.items.map((item) => (
        <li key={item.id}>Recent: {item.title}</li>
      ))}
    </ul>
  ),
}));

beforeEach(() => {
  reads.everything = [];
  reads.byTake = new Map();
  reads.balancesFailed = false;
  reads.takes = [];
});

describe("MoneyScreen", () => {
  it("keeps the receipts it could read when the balances couldn't load", () => {
    reads.balancesFailed = true;
    reads.everything = [move("w", "Withdrew $20")];

    const page = renderToStaticMarkup(<MoneyScreen openTake={null} />);

    expect(page).toContain("Couldn&#x27;t load your balances. Your money is untouched.");
    expect(page).toContain("Recent: Withdrew $20");
  });

  it("shows a take's own moves, however many newer ones other takes made", () => {
    reads.takes = [{ threadId: TAKE, title: "AI buildout", value: 0n, change: null, holdings: [] }];
    // The account's latest moves are all another take's; this take's first buy is older.
    reads.everything = Array.from({ length: 200 }, (_, index) =>
      move(`o${index}`, `Bought Solana ${index}`, "other"),
    );
    // A move its own chat didn't make, but which touched it, is still one of its moves.
    reads.byTake.set(TAKE, [
      move("sold", "Sold Tesla", "other"),
      move("first", "Bought Nvidia", TAKE),
    ]);

    const page = renderToStaticMarkup(<MoneyScreen openTake={TAKE} />);
    const takes = page.slice(0, page.indexOf("Recent:"));

    expect(takes).toContain("Bought Nvidia");
    expect(takes).toContain("Sold Tesla");
    expect(takes).not.toContain("Bought Solana");
  });
});
