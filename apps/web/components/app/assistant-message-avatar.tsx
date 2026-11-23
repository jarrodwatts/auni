import { Mascot, type MascotState } from "@/components/brand/mascot";
import { MessageAvatar } from "@/components/ui/message";

export function AssistantMessageAvatar({
  state = "color",
}: {
  readonly state?: MascotState;
}) {
  return (
    <MessageAvatar className="hidden size-8 translate-y-0! self-start bg-primary/5 ring-1 ring-primary/10 sm:flex">
      <Mascot alt="" eager size={27} state={state} />
    </MessageAvatar>
  );
}
