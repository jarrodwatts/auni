import type { AppAbout } from "@auni/shared";

export default {
  id: "relay",
  name: "Relay",
  does: "Brings coin for fees across chains",
  settings: {
    // Its docs ask every call to carry a key; unset, Auni calls it without one, as it answers today.
    apiKey: {
      env: "RELAY_API_KEY",
      label: "Relay API key",
      kind: "secret",
      help: "Only if Relay starts refusing calls without one. Get one from relay.link.",
      link: "https://relay.link/",
    },
  },
} satisfies AppAbout;
