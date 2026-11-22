import { defineApp } from "../contract.ts";
import about from "./about.ts";
import { localKeyWallet } from "./wallet.ts";

/** Keys kept on the owner's own machine, which Auni signs with itself: the default wallet. */
export default defineApp({ about, wallet: localKeyWallet });
