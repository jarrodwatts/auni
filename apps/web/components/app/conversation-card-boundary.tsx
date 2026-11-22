"use client";

import type { CardWire } from "@auni/shared";
import { Component, type ReactNode } from "react";

interface ConversationCardBoundaryProps {
  /** Named when it breaks: its kind, and a move's or proposal's id. */
  readonly card: CardWire;
  readonly children: ReactNode;
}

interface ConversationCardBoundaryState {
  readonly failed: boolean;
}

export class ConversationCardBoundary extends Component<
  ConversationCardBoundaryProps,
  ConversationCardBoundaryState
> {
  override state: ConversationCardBoundaryState = { failed: false };

  static getDerivedStateFromError(): ConversationCardBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    const { card } = this.props;
    console.error(`a ${card.kind} card couldn't draw`, {
      ...(card.kind === "action" ? { action: card.actionReference } : {}),
      ...("proposalId" in card ? { proposal: card.proposalId } : {}),
      error,
    });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="my-2 rounded-2xl bg-foreground/[0.027] px-4 py-3 ring-1 ring-foreground/[0.055] ring-inset">
        <p className="text-sm text-muted-foreground">This card couldn&apos;t load.</p>
      </div>
    );
  }
}
