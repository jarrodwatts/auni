import type { AppAbout } from "@auni/shared";

export default {
  id: "hyperliquid",
  name: "Hyperliquid",
  does: "Trade with leverage",
  starts: [
    {
      title: "Long BTC with $50",
      prompt: "Open a long on BTC with $50 on Hyperliquid.",
      moves: true,
    },
    {
      title: "What is funding costing me?",
      prompt: "What is funding costing me on my Hyperliquid positions?",
    },
    {
      title: "Close everything",
      prompt: "Close every position I have open on Hyperliquid.",
      moves: true,
    },
  ],
  // Each market's own logo.
  images: [{ hostname: "app.hyperliquid.xyz", pathname: "/coins/**" }],
  mark: { background: "#dff3ef", ring: "rgb(7 39 35 / 0.1)", fit: "contain", size: 0.68 },
  tools: {
    hyperliquid_order: {
      kind: "money",
      copy: ["Preparing your trade", "Prepared your trade", "Couldn’t prepare that trade"],
    },
    hyperliquid_close: {
      kind: "money",
      copy: [
        "Preparing to close your position",
        "Prepared to close your position",
        "Couldn’t prepare that close",
      ],
    },
    hyperliquid_set_stops: {
      kind: "money",
      copy: [
        "Preparing your safety limits",
        "Prepared your safety limits",
        "Couldn’t prepare those limits",
      ],
    },
    hyperliquid_cancel_order: {
      kind: "money",
      copy: [
        "Preparing to cancel your order",
        "Prepared to cancel your order",
        "Couldn’t prepare that cancel",
      ],
    },
    hyperliquid_deposit: {
      kind: "money",
      copy: ["Preparing a transfer", "Prepared a transfer", "Couldn’t prepare that transfer"],
      sends: true,
    },
    hyperliquid_withdraw: {
      kind: "money",
      copy: [
        "Preparing to bring your cash back",
        "Prepared to bring your cash back",
        "Couldn’t prepare that",
      ],
      sends: true,
    },
    hyperliquid_markets: {
      kind: "read",
      copy: ["Checking live prices", "Checked live prices", "Couldn’t check live prices"],
      icon: "chart",
    },
    hyperliquid_open_orders: {
      kind: "read",
      copy: ["Checking your open orders", "Checked your open orders", "Couldn’t check your orders"],
      icon: "search",
    },
    // A trade no order of Auni's made: a liquidation, auto-deleveraging, one in Hyperliquid's app.
    hyperliquid_venue_fill: { kind: "recorded" },
  },
} satisfies AppAbout;
