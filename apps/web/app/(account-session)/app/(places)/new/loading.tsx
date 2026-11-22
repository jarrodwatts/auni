import { ConversationWelcome } from "@/components/app/conversation-welcome";

/**
 * Every page here renders per request, and Next prefetches such a route only down to its first
 * loading boundary. This one looks like the page, so opening a new chat shows nothing in
 * between, but takes no input until the page is there.
 */
export default function NewChatLoading() {
  return <ConversationWelcome preview />;
}
