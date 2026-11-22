/**
 * Who core asks first, for the roles where the first answer wins. EVM swap routes are all asked
 * and the best quote wins, so their order doesn't matter. Here it does: the first brain that is
 * ready thinks (unless the owner's BRAIN names another), the first bridge and pay-in carry
 * core's own moves, the first Solana route lists and prices Solana's tokens, and the first feed
 * with a price is who Auni believes. So it is written down, not left to a
 * folder's place in the alphabet, and an app that fills one of these roles adds its id to the
 * end of that role's list: the one line outside its folder it changes (apps.test.ts fails
 * while the two disagree).
 */
export const ASKED_FIRST = {
  // Claude Code first: Auni's prompts, skills and tools are written for Claude.
  brain: ["claude-code", "codex"],
  bridge: ["across"],
  payIn: ["relay"],
  solana: ["jupiter"],
  tokens: ["defillama", "lifi", "coingecko", "dexscreener", "backed"],
} as const satisfies Readonly<Record<string, readonly string[]>>;
