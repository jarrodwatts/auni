import type { Step } from "../../money/history.ts";
import { cached, fetchJson } from "../../money/swaps/shared.ts";
import type { Prices } from "../contract.ts";
import { CLOB } from "./http.ts";

const MINUTES: Readonly<Record<Step | "1d", number>> = { "15m": 15, "1h": 60, "1d": 1_440 };

/** An outcome's live price: the middle of its book, as its history is drawn; kept a minute. */
const outcomeLive = cached(60_000, async (tokenId) => {
  const body = await fetchJson<{ mid?: string }>(
    `${CLOB}/midpoint?token_id=${encodeURIComponent(tokenId)}`,
  );
  return Number(body.mid);
});

/** An outcome share's price, by its token id, from Polymarket's book. */
export const polymarketPrices: Prices = {
  live: outcomeLive,
  async history(tokenId, step, from) {
    // No endTs: with one, Polymarket refuses a span over about 15 days (a pick's
    // 90 days); without, it answers to now.
    const body = await fetchJson<{ history: { t: number; p: number }[] }>(
      `${CLOB}/prices-history?market=${encodeURIComponent(tokenId)}&startTs=${Math.floor(from / 1_000)}&fidelity=${MINUTES[step]}`,
    );
    return body.history.map((point) => ({ at: point.t * 1_000, price: point.p }));
  },
};
