import type { AppAbout } from "@auni/shared";

export default {
  id: "claude-code",
  name: "Claude Code",
  does: "Thinks, on your own Claude login",
  settings: {
    // Only to have Claude Code bill an Anthropic API key rather than the owner's own Claude login.
    // Any ANTHROPIC_* already in core's environment is never handed on, so this is a deliberate
    // choice, and one the owner makes in their settings file: it changes whose account thinks.
    apiKey: { env: "AUNI_ANTHROPIC_API_KEY", label: "Anthropic API key", kind: "file" },
  },
} satisfies AppAbout;
