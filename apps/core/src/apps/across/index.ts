import { NETWORKS } from "@auni/shared";

import { defineApp } from "../contract.ts";
import { acrossBridge, acrossContracts, acrossQuote, acrossSend } from "./across.ts";
import about from "./about.ts";
import { problems } from "./problems.ts";
import { acrossReclaim } from "./rent.ts";

/** Across: the owner's USDC, and tokens sold home, between their own chains. */
export default defineApp({
  about,
  guide: "bridge_usdc moves cash between chains, into or out of Solana too.",
  moves: [acrossBridge, acrossReclaim],
  problems,
  bridge: {
    recipe: acrossBridge,
    input: ({ from, to, amount, token }) => ({
      from_chain: from,
      to_chain: to,
      amount,
      ...(token ? { from_token: token } : {}),
    }),
    quote: acrossQuote,
    send: acrossSend,
  },
  async addresses(chain) {
    const contracts = acrossContracts(NETWORKS[chain].viem.id);
    return new Map(contracts.map((contract) => [contract.toLowerCase(), "an Across bridge"]));
  },
});
