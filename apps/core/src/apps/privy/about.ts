import type { AppAbout } from "@auni/shared";

export default {
  id: "privy",
  name: "Privy",
  does: "Keeps your keys in your own Privy app",
  // With WALLET=privy: the owner's own Privy app, and the P-256 authorization key from its
  // dashboard that owns the server wallets Auni makes in it and signs every request for them.
  // Each changes who holds the owner's money, so none is ever written from the app.
  settings: {
    appId: { env: "PRIVY_APP_ID", label: "Privy app ID", kind: "file", required: true },
    appSecret: { env: "PRIVY_APP_SECRET", label: "Privy app secret", kind: "file", required: true },
    authorizationKey: {
      env: "PRIVY_AUTHORIZATION_KEY",
      label: "Privy authorization key",
      kind: "file",
      required: true,
    },
  },
} satisfies AppAbout;
