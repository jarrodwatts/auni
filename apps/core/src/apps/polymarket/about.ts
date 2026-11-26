import type { AppAbout } from "@auni/shared";

export default {
  id: "polymarket",
  name: "Polymarket",
  does: "Bet on what happens",
  starts: [
    {
      title: "What are people betting on?",
      prompt: "What are the biggest markets on Polymarket right now?",
    },
    {
      title: "Bet $20 on something I believe",
      prompt:
        "I want to put $20 on a Polymarket market. Ask me what I believe will happen, then find the market for it.",
      moves: true,
    },
    { title: "How are my bets doing?", prompt: "How are my Polymarket bets doing?" },
  ],
  // A market's own picture, on the card for a bet on it.
  images: [{ hostname: "polymarket-upload.s3.us-east-2.amazonaws.com", pathname: "/**" }],
  mark: { background: "#2e5cff", ring: "rgb(46 92 255 / 0.15)", fit: "cover", size: 1 },
  // A buy, and bringing cash back, go through Polymarket's relayer, which takes a builder's three
  // credentials. Unset, its markets can still be read, and a move says Polymarket isn't set up.
  settings: {
    builderKey: {
      env: "POLYMARKET_BUILDER_API_KEY",
      label: "Builder API key",
      kind: "secret",
      required: true,
      help: "From your builder profile on polymarket.com.",
    },
    builderSecret: {
      env: "POLYMARKET_BUILDER_SECRET",
      label: "Builder secret",
      kind: "secret",
      required: true,
    },
    builderPassphrase: {
      env: "POLYMARKET_BUILDER_PASSPHRASE",
      label: "Builder passphrase",
      kind: "secret",
      required: true,
    },
  },
  tools: {
    polymarket_order: {
      kind: "money",
      copy: [
        "Preparing your prediction",
        "Prepared your prediction",
        "Couldn’t prepare that prediction",
      ],
    },
    polymarket_withdraw: {
      kind: "money",
      copy: [
        "Preparing to bring your cash back",
        "Prepared to bring your cash back",
        "Couldn’t prepare that",
      ],
      sends: true,
    },
    polymarket_markets: {
      kind: "read",
      copy: [
        "Checking the prediction markets",
        "Checked the prediction markets",
        "Couldn’t check the prediction markets",
      ],
      icon: "search",
    },
    // Polymarket paying out a resolved market.
    polymarket_payout: { kind: "recorded" },
  },
} satisfies AppAbout;
