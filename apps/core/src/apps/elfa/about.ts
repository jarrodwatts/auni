import type { AppAbout } from "@auni/shared";

export default {
  id: "elfa",
  name: "Elfa",
  does: "Market news, read from what people post",
  starts: [
    {
      title: "What's the story this week?",
      prompt: "What are the week's biggest market stories?",
    },
    {
      title: "Who is talking about SOL?",
      prompt: "Who is talking about SOL this week, and what are they saying?",
    },
    {
      title: "Tell me when a story breaks",
      prompt: "Watch the news for me and tell me when a big story breaks on something I hold.",
    },
  ],
  mark: { background: "#f1eaff", ring: "rgb(98 32 235 / 0.14)", fit: "contain", size: 0.76 },
  watchIcon: "news",
  settings: {
    // Its data API and Elfa Auto, the watch source, share one key. Unset, the agent is offered neither.
    apiKey: {
      env: "ELFA_AUTO_API_KEY",
      label: "Elfa API key",
      kind: "secret",
      required: true,
      help: "Get one at elfa.ai, under Developers.",
      link: "https://www.elfa.ai/",
    },
  },
  tools: {
    market_news: {
      kind: "read",
      copy: ["Reading the news", "Read the news", "Couldn’t read the news"],
      icon: "news",
    },
    market_attention: {
      kind: "read",
      copy: [
        "Checking what people are talking about",
        "Checked what people are talking about",
        "Couldn’t check what people are talking about",
      ],
      icon: "chart",
    },
    market_positioning: {
      kind: "read",
      copy: [
        "Checking how traders are positioned",
        "Checked how traders are positioned",
        "Couldn’t check how traders are positioned",
      ],
      icon: "chart",
    },
    market_pulse: {
      kind: "read",
      copy: ["Reading the week", "Read the week", "Couldn’t read the week"],
      icon: "chart",
    },
  },
} satisfies AppAbout;
