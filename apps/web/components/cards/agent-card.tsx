import type { CardWire } from "@auni/shared";

import { AppCard } from "./app-card";
import { ArrivalCard } from "./arrival-card";
import { AskCard } from "./ask-card";
import type { AskAgentHandler } from "./ask-agent";
import { ActionCard } from "./money/action-card";
import { ActionPlanCard } from "./money/action-plan-card";
import { DepositCard } from "./deposit-card";
import { FeedbackCard } from "./feedback-card";
import { VenueEventCard } from "./venue-event-card";

export function AgentCard({
  card,
  onAskAgent,
}: {
  readonly card: CardWire;
  /** Absent on surfaces with no composer; cards then offer no follow-up. */
  readonly onAskAgent?: AskAgentHandler;
}) {
  switch (card.kind) {
    case "action":
      return <ActionCard card={card} onAskAgent={onAskAgent} />;
    case "action_plan":
      return <ActionPlanCard card={card} onAskAgent={onAskAgent} />;
    case "automation":
      // One line under the answer stands for every watch it set up (see WatchingLine).
      return null;
    case "ask":
      return <AskCard card={card} />;
    case "app":
      return <AppCard card={card} />;
    case "arrival":
      return <ArrivalCard card={card} />;
    case "deposit":
      return <DepositCard card={card} />;
    case "feedback":
      return <FeedbackCard card={card} />;
    case "venue_event":
      return <VenueEventCard card={card} />;
    default:
      // Every kind is handled at compile time; a card from an older build draws nothing.
      void (card satisfies never);
      return null;
  }
}
