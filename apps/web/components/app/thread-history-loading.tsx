import { AssistantMessageAvatar } from "@/components/app/assistant-message-avatar";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Message, MessageContent } from "@/components/ui/message";

/** Localized history placeholder that preserves the surrounding workspace. */
export function ThreadHistoryLoading() {
  return (
    <div role="status" aria-live="polite" className="auni-history-loading flex flex-col gap-6">
      <span className="sr-only">Loading conversation history</span>

      <div className="auni-loading-row flex justify-end">
        <span className="auni-loading-sheen h-12 w-[42%] max-w-[310px] rounded-[20px_20px_6px_20px]" />
      </div>

      <Message className="auni-loading-row [animation-delay:70ms]" align="start">
        <AssistantMessageAvatar loading />
        <MessageContent>
          <Bubble align="start" className="w-full max-w-full" variant="ghost">
            <BubbleContent className="relative w-full text-[15px] leading-relaxed">
              <span className="flex h-6 items-center">
                <span className="auni-loading-sheen block h-3 w-[82%] rounded-full" />
              </span>
              <span className="flex h-6 items-center">
                <span className="auni-loading-sheen block h-3 w-[68%] rounded-full" />
              </span>
              <span className="flex h-6 items-center">
                <span className="auni-loading-sheen block h-3 w-[76%] rounded-full" />
              </span>
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>

      <div className="auni-loading-row [animation-delay:140ms] sm:ml-10">
        <span className="flex h-6 items-center">
          <span className="auni-loading-sheen block h-3 w-[58%] rounded-full" />
        </span>
        <span className="flex h-6 items-center">
          <span className="auni-loading-sheen block h-3 w-[43%] rounded-full" />
        </span>
      </div>
    </div>
  );
}
