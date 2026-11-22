import { PrivyClient } from "@privy-io/node";

import { requiredSetting } from "../../settings.ts";
import about from "./about.ts";

let client: PrivyClient | undefined;

/** The owner's own Privy app (WALLET=privy), which holds Auni's two server wallets. */
export function privyClient(): PrivyClient {
  client ??= new PrivyClient({
    appId: requiredSetting(about, "appId"),
    appSecret: requiredSetting(about, "appSecret"),
  });
  return client;
}
