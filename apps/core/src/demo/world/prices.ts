import type { Asked, Service } from "../world.ts";

// What things are worth in the demo. Every price is one fixed curve, laid on this machine's clock
// from the start of the day the demo runs, so what the owner's past paid, what they hold now and
// how it moved today read the same at any hour. The past week alone still moves with the hour,
// since the app measures it from a week before now, unless the demo's clock is stopped at a
// moment (clock.ts). Each stand-in service that says a price reads it from here.

/** When this demo started. */
export const STARTED = Date.now();

const DAY_MS = 24 * 60 * 60_000;

/** Something with a price. */
interface Priced {
  /** Dollars at the start of the day the demo runs. */
  readonly usd: number;
  /** How far it wanders either side of its trend, as a share of its price: 0.04 is 4%. */
  readonly swing: number;
  /** How much it gains each day, as a share of its price: it was cheaper a week ago. */
  readonly trend: number;
}

/** Everything the demo prices, by the symbol people know it by. */
const ASSETS = {
  BTC: { usd: 98_400, swing: 0.035, trend: 0.004 },
  ETH: { usd: 3_420, swing: 0.045, trend: 0.003 },
  SOL: { usd: 186, swing: 0.06, trend: 0.005 },
  MON: { usd: 0.42, swing: 0.08, trend: 0.002 },
  POL: { usd: 0.51, swing: 0.05, trend: -0.001 },
  NVDA: { usd: 172, swing: 0.03, trend: 0.004 },
  TSLA: { usd: 418, swing: 0.05, trend: 0.002 },
  COIN: { usd: 291, swing: 0.055, trend: -0.002 },
  LLY: { usd: 842, swing: 0.03, trend: 0.003 },
  NVO: { usd: 68, swing: 0.04, trend: 0.001 },
  // An ounce of gold, which Tether Gold tracks.
  XAU: { usd: 3_870, swing: 0.01, trend: 0.0005 },
} as const satisfies Record<string, Priced>;

export type AssetSymbol = keyof typeof ASSETS;

/** Whether the demo prices something that goes by `symbol`. */
export const isPriced = (symbol: string): symbol is AssetSymbol => symbol in ASSETS;

/** A number that is the same for a name on every run, between 0 and 2π. */
function phase(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 6_283;
  return hash / 1_000;
}

/** Three waves of different lengths, which read as a market rather than a sine. */
function wander(days: number, seed: number): number {
  return (
    0.55 * Math.sin(days * 0.9 + seed) +
    0.3 * Math.sin(days * 3.7 + seed * 2.3) +
    0.15 * Math.sin(days * 17 + seed * 5.1)
  );
}

/** The start of the day the demo runs, on this machine's clock: the curve's day 0. */
export const TODAY = new Date(STARTED).setHours(0, 0, 0, 0);

const HOUR = 1 / 24;
/**
 * The demo's clock as the curve reads it: a moment, in days from TODAY, and where on the curve
 * it sits, running straight between knots. "Today" is measured from the owner's midnight, so
 * today is played the same whenever the demo runs: the hour before midnight stands at day 0, so
 * today starts from one price whatever minute a reading falls in, and today plays the curve's
 * first 16 hours in its first hour, then stands still, so what is held is worth the same all day.
 * Before that hour the curve runs as the clock does.
 */
const KNOTS: readonly (readonly [at: number, curve: number])[] = [
  [-1, -1],
  [-HOUR, 0],
  [0, 0],
  [HOUR, 16 * HOUR],
];

/** The moment the demo's prices are played at in place of now, and how far behind the clock it is. */
let played: { readonly at: number; readonly lagMs: number } | undefined;

/**
 * Has every price the demo gives be the one at `at`, a moment `lagMs` before the clock's, until
 * it is set back with no moment: the seed plays each step of the owner's past at its own time's
 * prices. They stand at `at` for as long as the step takes to play, so what the step paid is the
 * same on every run; a price asked for as of an earlier moment is the one that long before `at`.
 */
export function playPricesAt(at?: number, lagMs = 0): void {
  played = at === undefined ? undefined : { at, lagMs };
}

/** Where on the curve the prices at `at` (now, by default) sit, in days (see KNOTS). */
export function curveDays(at: number = Date.now()): number {
  const moment = played ? Math.min(at - played.lagMs, played.at) : at;
  const days = (moment - TODAY) / DAY_MS;
  const after = KNOTS.findIndex(([knot]) => knot > days);
  if (after === 0) return days;
  if (after === -1) return KNOTS.at(-1)![1];
  const [fromAt, fromCurve] = KNOTS[after - 1]!;
  const [toAt, toCurve] = KNOTS[after]!;
  return fromCurve + ((days - fromAt) / (toAt - fromAt)) * (toCurve - fromCurve);
}

/** What an asset was worth at `at`, in dollars: the same on every stand-in service that prices it. */
export function usdOf(symbol: AssetSymbol, at?: number): number {
  const asset: Priced = ASSETS[symbol];
  const days = curveDays(at);
  const seed = phase(symbol);
  const moved = asset.trend * days + asset.swing * (wander(days, seed) - wander(0, seed));
  return asset.usd * Math.max(0.05, 1 + moved);
}

/** The coins DefiLlama prices in the demo, by its coin id ("coingecko:solana", "monad:0x…"). */
const coins = new Map<string, AssetSymbol>([
  ["coingecko:bitcoin", "BTC"],
  ["coingecko:ethereum", "ETH"],
  ["coingecko:solana", "SOL"],
  ["coingecko:monad", "MON"],
  ["coingecko:polygon-ecosystem-token", "POL"],
]);

/** Has DefiLlama's stand-in price a coin id as one of the demo's assets. */
export function priceCoin(id: string, symbol: AssetSymbol): void {
  coins.set(id.toLowerCase(), symbol);
}

const PERIOD_MS: Readonly<Record<string, number>> = { m: 60_000, h: 60 * 60_000, d: DAY_MS };

/** "15m", "2h", "1d" in milliseconds. */
function periodMs(period: string): number {
  const match = /^(\d+)([mhd])$/u.exec(period);
  if (!match) throw new Error(`The demo's price feed doesn't know the period ${period}.`);
  return Number(match[1]) * PERIOD_MS[match[2]!]!;
}

/** DefiLlama's coin prices (apps/defillama): now, at a past moment, as a chart, and over a day. */
export const defiLlama: Service = {
  hosts: ["coins.llama.fi"],
  answer({ url }: Asked) {
    const [kind, ...rest] = url.pathname.split("/").filter(Boolean);
    const priced = (ids: string, at: number) =>
      Object.fromEntries(
        decodeURIComponent(ids)
          .split(",")
          .flatMap((id) => {
            const asset = coins.get(id.toLowerCase());
            return asset
              ? [[id, { price: usdOf(asset, at), symbol: asset, confidence: 0.99 }]]
              : [];
          }),
      );
    if (kind === "prices" && rest[0] === "current") return { coins: priced(rest[1]!, Date.now()) };
    if (kind === "prices" && rest[0] === "historical")
      return { coins: priced(rest[2]!, Number(rest[1]) * 1_000) };
    if (kind === "percentage") {
      // The demo's last day is today, from its midnight, so a day's change agrees with the app's.
      const now = priced(rest[0]!, Date.now());
      const before = priced(rest[0]!, TODAY);
      return {
        coins: Object.fromEntries(
          Object.keys(now).map((id) => [id, (now[id]!.price / before[id]!.price - 1) * 100]),
        ),
      };
    }
    if (kind === "chart") {
      const id = decodeURIComponent(rest[0]!);
      const asset = coins.get(id.toLowerCase());
      if (!asset) return { coins: {} };
      const start = Number(url.searchParams.get("start")) * 1_000;
      const step = periodMs(url.searchParams.get("period") ?? "1d");
      const span = Number(url.searchParams.get("span") ?? 1);
      const prices = Array.from({ length: span }, (_, index) => start + index * step)
        .filter((at) => at <= Date.now())
        .map((at) => ({ timestamp: Math.floor(at / 1_000), price: usdOf(asset, at) }));
      return { coins: { [id]: { symbol: asset, confidence: 0.99, prices } } };
    }
    return undefined;
  },
};
