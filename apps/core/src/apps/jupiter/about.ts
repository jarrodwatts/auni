import type { AppAbout } from "@auni/shared";

export default {
  id: "jupiter",
  name: "Jupiter",
  does: "Swaps tokens and stocks on Solana",
  // Where the Solana tokens it lists keep their artwork, PreStocks' pre-IPO tokens among them.
  images: [
    { hostname: "static.jup.ag", pathname: "/**" },
    { hostname: "www.prestocks.com", pathname: "/logos/**" },
    { hostname: "arweave.net", pathname: "/**" },
    { hostname: "**.arweave.net", pathname: "/**" },
    { hostname: "ipfs.io", pathname: "/ipfs/**" },
    { hostname: "**.ipfs.nftstorage.link", pathname: "/**" },
    { hostname: "gateway.irys.xyz", pathname: "/**" },
  ],
  settings: {
    // Unset, Solana tokens can't be listed, priced or swapped, and its tools say so.
    apiKey: {
      env: "JUPITER_API_KEY",
      label: "Jupiter API key",
      kind: "secret",
      required: true,
      help: "Get one at portal.jup.ag.",
      link: "https://portal.jup.ag/",
    },
  },
  mark: { background: "#111727", ring: "rgb(17 23 39 / 0.15)", fit: "cover", size: 1 },
} satisfies AppAbout;
