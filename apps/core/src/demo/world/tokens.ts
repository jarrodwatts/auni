import { NETWORKS, type EvmChainKey } from "@auni/shared";
import type { Address } from "viem";

import { refuse, type Asked, type Service } from "../world.ts";
import { addressOf, chains, NATIVE } from "./chain.ts";
import { isPriced, priceCoin, usdOf, type AssetSymbol } from "./prices.ts";

// The tokens the demo's chains hold besides USDC, and the services that say what a token is:
// Backed's catalog of tokenized stocks, LI.FI's token listing and CoinGecko's token lists. Each
// is a few lines of the same table, so what a token is called and worth agrees everywhere, but
// where a list says it its own way, as the live ones do.

interface DemoToken {
  readonly chain: EvmChainKey;
  readonly address: Address;
  readonly symbol: string;
  readonly name: string;
  readonly decimals: number;
  /** What prices it; a dollar token has none, and is worth a dollar. */
  readonly asset: AssetSymbol | null;
  /** Its picture on LI.FI's listing; null for none there. */
  readonly logo: string | null;
  /** How CoinGecko's list writes it, where that isn't its own symbol and name. */
  readonly listedAs?: { readonly symbol: string; readonly name: string };
}

/** A tokenized stock on Monad, at an address of the demo's own. */
function stock(asset: AssetSymbol, name: string): DemoToken {
  return {
    chain: "monad",
    address: addressOf(`${asset}x`),
    symbol: `${asset}x`,
    name: `${name} xStock`,
    decimals: 18,
    asset,
    // The picture its listing gives, as a live stock wears it, drawn from Backed's own listing.
    logo: `https://xstocks-metadata.backed.fi/logos/tokens/${asset}x.png`,
  };
}

const STOCKS = [
  stock("NVDA", "Nvidia"),
  stock("TSLA", "Tesla"),
  stock("COIN", "Coinbase"),
  stock("LLY", "Eli Lilly"),
  stock("NVO", "Novo Nordisk"),
];

/** What staking MON with the demo's Kintsu gives back (world/kintsu.ts): worth a MON each. */
export const STAKED_MON: DemoToken = {
  chain: "monad",
  address: addressOf("sMON"),
  symbol: "sMON",
  name: "Kintsu Staked Monad",
  decimals: 18,
  asset: "MON",
  logo: "/brand/tokens/mon.png",
};

/**
 * Tether Gold on Monad, as the live lists have it: its contract and LI.FI name it by its symbol,
 * and CoinGecko's list calls it Tether Gold Tokens, its symbol in capitals. LI.FI's picture of it
 * is on a host the demo doesn't reach, so it has none here, and draws as its initials.
 */
const TETHER_GOLD: DemoToken = {
  chain: "monad",
  address: addressOf("XAUt0"),
  symbol: "XAUt0",
  name: "XAUt0",
  decimals: 6,
  asset: "XAU",
  logo: null,
  listedAs: { symbol: "XAUT0", name: "Tether Gold Tokens" },
};

const TOKENS: readonly DemoToken[] = [
  ...STOCKS,
  STAKED_MON,
  TETHER_GOLD,
  ...(["monad", "base", "arbitrum", "polygon"] as const).map((chain): DemoToken => ({
    chain,
    address: NETWORKS[chain].usdc,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    asset: null,
    logo: "/brand/tokens/usdc.svg",
  })),
];

for (const token of TOKENS) {
  chains.get(token.chain)!.list(token.address, token);
  if (token.asset) priceCoin(`${token.chain}:${token.address}`, token.asset);
}

/** A token the demo lists on a chain, by its address there. */
export function tokenAt(chain: EvmChainKey, address: string): DemoToken | undefined {
  return TOKENS.find(
    (token) => token.chain === chain && token.address.toLowerCase() === address.toLowerCase(),
  );
}

/** A chain's own coin, where the demo prices it, at the address that stands for one in a listing. */
function coinAt(chain: EvmChainKey, address: string): DemoToken | undefined {
  const { asset, decimals } = NETWORKS[chain].coin;
  if (address.toLowerCase() !== NATIVE.toLowerCase() || !isPriced(asset.symbol)) return undefined;
  const { symbol, name, logoUrl: logo } = asset;
  return { chain, address: NATIVE, symbol, name, decimals, asset: symbol, logo };
}

/** Dollars one whole token is worth now. */
export function tokenUsd(token: DemoToken): number {
  return token.asset ? usdOf(token.asset) : 1;
}

/** Backed's catalog (apps/backed): every stock on its first page, and an open market. */
export const backed: Service = {
  hosts: ["api.backed.fi"],
  answer({ url }: Asked) {
    if (url.pathname === "/api/v2/public/assets")
      return {
        nodes:
          url.searchParams.get("page") === "0"
            ? STOCKS.map((token) => ({
                name: token.name,
                symbol: token.symbol,
                underlyingSymbol: token.asset,
                logo: token.logo,
                deployments: [{ address: token.address, network: "Monad" }],
              }))
            : [],
      };
    if (url.pathname.startsWith("/api/v2/public/assets/"))
      return { isTradingHalted: false, trading: { isTradingHalted: false, openNow: true } };
    return undefined;
  },
};

/** LI.FI's listing of one token (apps/lifi/tokens.ts): a 400 for one it doesn't list. */
export const lifi: Service = {
  hosts: ["li.quest"],
  answer({ url }: Asked) {
    if (url.pathname !== "/v1/token") return undefined;
    const chain = [...chains.values()].find(
      ({ id }) => String(id) === url.searchParams.get("chain"),
    );
    const asked = url.searchParams.get("token") ?? "";
    const token = chain && (tokenAt(chain.name, asked) ?? coinAt(chain.name, asked));
    if (!token) return refuse(400, { message: "The demo's LI.FI doesn't list this token." });
    return {
      address: token.address,
      chainId: chain.id,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      priceUSD: String(tokenUsd(token)),
      ...(token.logo ? { logoURI: token.logo } : {}),
    };
  },
};

/** CoinGecko's token list for a chain (apps/coingecko): the tokens the demo lists there. */
export const coingecko: Service = {
  hosts: ["tokens.coingecko.com", "api.coingecko.com"],
  answer({ url }: Asked) {
    if (url.hostname === "api.coingecko.com") {
      if (url.pathname === "/api/v3/asset_platforms")
        return [...chains.values()].map(({ id, name }) => ({
          id: NETWORKS[name].coingecko,
          chain_identifier: id,
        }));
      // A token's page, asked for its picture: the demo's tokens have none there.
      return /^\/api\/v3\/coins\/[^/]+\/contract\//u.test(url.pathname)
        ? refuse(404, { error: "coin not found" })
        : undefined;
    }
    const platform = url.pathname.split("/")[1];
    return {
      tokens: TOKENS.filter(({ chain }) => NETWORKS[chain].coingecko === platform).map(
        ({ address, symbol, name, decimals, listedAs }) => ({
          address,
          ...(listedAs ?? { symbol, name }),
          decimals,
        }),
      ),
    };
  },
};
