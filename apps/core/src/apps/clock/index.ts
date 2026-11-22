import { defineApp } from "../contract.ts";
import about from "./about.ts";
import { clockSource } from "./source.ts";

/**
 * Clock: wakes the agent at a time, once or on a schedule, on the owner's own clock. It needs
 * nothing but this machine, and is the smallest whole watch source, to copy from. Like prices, it
 * is part of Auni's own work, so the owner has no switch for it, and the agent can always be
 * woken at a time.
 */
export default defineApp({ about, watches: clockSource });
