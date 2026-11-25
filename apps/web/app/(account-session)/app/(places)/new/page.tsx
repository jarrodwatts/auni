import type { Metadata } from "next";

import { ConversationWelcome } from "@/components/app/conversation-welcome";

export const metadata: Metadata = { title: "New take" };

export default function NewChatPage() {
  return <ConversationWelcome />;
}
