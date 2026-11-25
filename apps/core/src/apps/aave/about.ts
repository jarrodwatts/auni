import type { AppAbout } from "@auni/shared";

export default {
  id: "aave",
  name: "Aave",
  does: "Earn on idle cash",
  starts: [
    {
      title: "Put my idle cash to work",
      prompt: "Put my idle cash into Aave so it earns.",
      moves: true,
    },
    {
      title: "What does it pay now?",
      prompt: "What does Aave pay on cash right now, on each chain I could use?",
    },
    {
      title: "Take it all back out",
      prompt: "Take everything I have in Aave back out to cash.",
      moves: true,
    },
  ],
  mark: {
    background: "rgb(255 255 255 / 0.8)",
    ring: "rgb(147 145 247 / 0.15)",
    fit: "contain",
    size: 0.76,
  },
  tools: {
    aave_supply: {
      kind: "money",
      copy: [
        "Preparing your savings deposit",
        "Prepared your savings deposit",
        "Couldn’t prepare that deposit",
      ],
      sends: true,
    },
    aave_withdraw: {
      kind: "money",
      copy: [
        "Preparing to take money out of savings",
        "Prepared to take money out of savings",
        "Couldn’t prepare that withdrawal",
      ],
      sends: true,
    },
  },
} satisfies AppAbout;
