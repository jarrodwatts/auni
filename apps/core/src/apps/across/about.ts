import type { AppAbout } from "@auni/shared";

export default {
  id: "across",
  name: "Across",
  does: "Moves cash between chains",
  tools: {
    bridge_usdc: {
      kind: "money",
      copy: [
        "Preparing to move your money",
        "Prepared to move your money",
        "Couldn’t prepare that move",
      ],
      sends: true,
    },
    // Getting back the SOL Circle held for a bridge out of Solana, which that bridge's card allows.
    across_reclaim: {
      kind: "later",
      copy: [
        "Getting back the SOL Circle held",
        "Got back the SOL Circle held",
        "Couldn’t get back the SOL Circle held",
      ],
      sends: true,
    },
  },
} satisfies AppAbout;
