import { Mascot, type MascotState } from "@/components/brand/mascot";
import { MessageAvatar } from "@/components/ui/message";
import { cn } from "@/lib/utils";

export function AssistantMessageAvatar({
  loading = false,
  state = "color",
}: {
  readonly loading?: boolean;
  readonly state?: MascotState;
}) {
  return (
    <MessageAvatar
      className={cn(
        "hidden size-8 translate-y-0! self-start bg-primary/5 ring-1 ring-primary/10 sm:flex",
        loading && "auni-loading-mascot",
      )}
    >
      <Mascot alt="" eager size={27} state={state} />
    </MessageAvatar>
  );
}
