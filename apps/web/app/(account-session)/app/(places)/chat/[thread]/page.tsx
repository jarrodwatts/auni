import { threadIdSchema } from "@auni/shared";
import { notFound } from "next/navigation";

import { ChatPlace } from "@/components/places/chat-place";

export default async function ChatRoute({ params }: { params: Promise<{ thread: string }> }) {
  const parsed = threadIdSchema.safeParse((await params).thread);
  if (!parsed.success) notFound();

  return <ChatPlace key={parsed.data} threadId={parsed.data} />;
}
