import { defineApp, type App } from "../apps/contract.ts";
import { demoBrain } from "./brain.ts";
import { demoWallet } from "./wallet.ts";

// The demo's brain and its wallet, each an app by the same contract every app keeps, so the
// Apps list shows them as it shows a real brain and a real wallet.

const brain = defineApp({
  about: { id: "demo-brain", name: "Scripted AI", does: "Answers from a script, for the demo" },
  brain: demoBrain,
});

const wallet = defineApp({
  about: { id: "demo-wallet", name: "Demo wallet", does: "Signs for no real network" },
  wallet: { ...demoWallet, byDefault: true },
});

/**
 * The apps a demo runs with: every real one that neither thinks nor signs, and the demo's own
 * two in their place. So no real CLI is ever started and no real key is ever reached, while
 * every venue, lookup, watch source and channel is the real code, talking to the demo's world.
 */
export function demoApps(real: readonly App[]): readonly App[] {
  return [...real.filter((app) => !app.brain && !app.wallet), brain, wallet];
}
