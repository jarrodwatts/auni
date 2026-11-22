import type { Metadata } from "next";

import { ConversationWelcome } from "@/components/app/conversation-welcome";

// What the page asks, as first run's landing over it asks it too.
export const metadata: Metadata = { title: "What do you believe?" };

export default function NewChatPage() {
  return <ConversationWelcome />;
}
