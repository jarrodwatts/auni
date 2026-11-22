import { defineApp } from "../contract.ts";
import about from "./about.ts";
import { privyWallet } from "./wallet.ts";

/** Server wallets in the owner's own Privy app, signed for with their authorization key. */
export default defineApp({ about, wallet: privyWallet });
