/**
 * The assets people know by name, with the crisp artwork Auni ships for
 * them. A wallet holds Ether as WETH and venues list it with small artwork,
 * but nobody believes in "WETH": core names holdings and picks with these,
 * so every surface says the same thing.
 */
export interface KnownAsset {
  readonly name: string;
  readonly symbol: string;
  readonly logoUrl: string;
}

export const ETHEREUM: KnownAsset = {
  name: "Ethereum",
  symbol: "ETH",
  logoUrl: "/brand/chains/ethereum.svg",
};
const BITCOIN: KnownAsset = {
  name: "Bitcoin",
  symbol: "BTC",
  logoUrl: "/brand/tokens/btc.svg",
};
export const SOLANA: KnownAsset = {
  name: "Solana",
  symbol: "SOL",
  logoUrl: "/brand/tokens/sol.png",
};
export const BNB: KnownAsset = { name: "BNB", symbol: "BNB", logoUrl: "/brand/chains/bnb.svg" };
export const MONAD: KnownAsset = { name: "Monad", symbol: "MON", logoUrl: "/brand/tokens/mon.png" };
export const POLYGON: KnownAsset = {
  name: "Polygon",
  symbol: "POL",
  logoUrl: "/brand/tokens/pol.png",
};

/** Each asset under the other names it goes by, besides its own name and symbol. */
const ALIASES: readonly (readonly [KnownAsset, readonly string[]])[] = [
  [ETHEREUM, ["ether", "weth", "wrapped ether"]],
  [BITCOIN, ["wbtc", "cbbtc", "wrapped bitcoin"]],
  [SOLANA, ["wsol", "wrapped sol"]],
  [MONAD, ["wmon"]],
  [POLYGON, ["wpol"]],
  [BNB, ["wbnb"]],
  [{ name: "USDC", symbol: "USDC", logoUrl: "/brand/tokens/usdc.svg" }, []],
];

const BY_NAME = new Map(
  ALIASES.flatMap(([asset, aliases]) =>
    [asset.name, asset.symbol, ...aliases].map((name) => [name.toLowerCase(), asset] as const),
  ),
);

/** The known asset a name or symbol means, whatever its case; null for anything else. */
export function knownAsset(name: string): KnownAsset | null {
  return BY_NAME.get(name.trim().toLowerCase()) ?? null;
}
