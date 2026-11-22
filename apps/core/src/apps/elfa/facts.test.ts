import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { newsFacts } from "./facts.ts";
import entities from "./fixtures/hype-entities.json";
import week from "./fixtures/hype-events-7d.json";

const asked: URL[] = [];

beforeEach(() => {
  asked.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      asked.push(url);
      return Response.json(url.pathname === "/v3/entities" ? entities : week);
    }),
  );
});
afterEach(() => {
  delete process.env.ELFA_AUTO_API_KEY;
  vi.unstubAllGlobals();
});

const HYPE_LOGO = "https://app.hyperliquid.xyz/coins/HYPE.svg";
const holdingHype = {
  holdings: [{ symbol: "HYPE", name: "Hyperliquid", usdValue: "40.00", image: HYPE_LOGO }],
};

describe("newsFacts", () => {
  it("tells the latest story on what the owner holds, linked to a post behind it, wearing the holding's logo", async () => {
    process.env.ELFA_AUTO_API_KEY = "elfa-test";
    expect(await newsFacts(holdingHype)).toEqual([
      {
        text: 'News on HYPE, which the owner holds, written up from posts on X and Telegram: "Hyperliquid Strategies adds about 5.1 million HYPE in 29 days".',
        label: "Hyperliquid Strategies adds about 5.1 million HYPE in 29 days",
        link: "https://x.com/Havochl_/status/2111004930727186591",
        image: HYPE_LOGO,
        starts: [
          {
            statement: "News on your HYPE.",
            action: "What next?",
            prompt:
              'There\'s news on HYPE, which I hold: "Hyperliquid Strategies adds about 5.1 million HYPE in 29 days". What does it mean for my position?',
          },
        ],
      },
    ]);
    const events = asked.find((url) => url.pathname === "/v3/events")!;
    expect(events.searchParams.get("entityIds")).toBe(entities.entities[0]!.id);
  });

  it("tells nothing without Elfa's key", async () => {
    expect(await newsFacts(holdingHype)).toEqual([]);
    expect(asked).toEqual([]);
  });
});
