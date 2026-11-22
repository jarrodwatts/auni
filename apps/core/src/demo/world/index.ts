import { refuse, type Service } from "../world.ts";
import "./aave.ts";
import { evmRpc } from "./chain.ts";
import { circle } from "./circle.ts";
import { hyperliquid } from "./hyperliquid.ts";
import { kyberswap } from "./kyberswap.ts";
import { polymarket } from "./polymarket.ts";
import { defiLlama } from "./prices.ts";
import { solanaRpc } from "./solana.ts";
import { backed, coingecko, lifi } from "./tokens.ts";

/** Services the demo knowingly goes without: each answers as if down, and core carries on. */
const absent: Service = {
  hosts: [
    // LI.FI's stock orders: the demo's stocks trade through its swap route instead.
    "order.li.fi",
    // Pictures: a site's own icon for an app the brain names, and a token's from DexScreener.
    // The demo's cards draw initials for both, so its pictures need nothing from outside.
    "t1.gstatic.com",
    "api.dexscreener.com",
  ],
  answer: () => refuse(503, { message: "The demo goes without this service." }),
};

/** Every outside service the demo answers for. A request to any other host is refused. */
export const services: readonly Service[] = [
  evmRpc,
  solanaRpc,
  defiLlama,
  backed,
  lifi,
  coingecko,
  kyberswap,
  hyperliquid,
  circle,
  polymarket,
  absent,
];
