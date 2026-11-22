import { defineApp } from "../contract.ts";
import { tryKeyAt } from "../../try-key.ts";
import about from "./about.ts";
import { deposit, DEPOSITORY, quote, RELAY_API, status } from "./relay.ts";

/** Relay: quotes carrying USDC from another chain to an address of the owner's, in a second or two. */
export default defineApp({
  about,
  payIn: { depository: DEPOSITORY, deposit, quote, status },
  // The key's own call counts: its other calls answer with any key, or none, today.
  tryKey: (_key, value) =>
    tryKeyAt(`${RELAY_API}/metrics/usage`, { headers: { "x-api-key": value } }),
});
