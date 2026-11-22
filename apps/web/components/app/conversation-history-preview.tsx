import type { ReactNode } from "react";

import { Conversation, ConversationContent } from "@/components/ai-elements/conversation";

/** The transcript's column, shared so a stand-in and the live thread line up to the pixel. */
export const TRANSCRIPT_COLUMN_CLASS_NAME =
  "relative mx-auto w-full max-w-[780px] px-4 pt-5 sm:px-0 sm:pt-0";

/** A transcript nothing arrives in, drawn in the same frame the live thread will be. */
export function ConversationHistoryPreview({ children }: { readonly children: ReactNode }) {
  return (
    <Conversation>
      <ConversationContent className={TRANSCRIPT_COLUMN_CLASS_NAME}>{children}</ConversationContent>
    </Conversation>
  );
}
