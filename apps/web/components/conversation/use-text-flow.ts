"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  createTextFlow,
  flowTextChanged,
  flowTimerFired,
  flushFlow,
  isAnimating,
  isFlowComplete,
  isFlowing,
  type TextFlowResult,
  type TextFlowState,
} from "@/lib/text-flow";
import { messageText, type AuniUiMessage } from "@/lib/conversation";

const flowedMessageIds = new Set<string>();

/** What the renderer needs to draw the live message as one typing cursor. */
export interface TextFlowView {
  /** Chars of the message text to show; a strictly growing prefix. */
  readonly visibleLength: number;
  /** Keep the animated (streaming) markdown mounted while true. */
  readonly animating: boolean;
}

interface FlowMachine {
  messageId: string | null;
  state: TextFlowState | null;
  text: string;
  timer: number | null;
  /** Pending coalesced snapshot commit (rAF id), if any. */
  commitFrame: number | null;
  /** Setter registered by the effect; lets timer callbacks commit directly. */
  commitSetter: SnapshotSetter | null;
}

interface FlowSnapshot {
  readonly messageId: string;
  readonly view: TextFlowView;
  readonly revealing: boolean;
}

interface TrailingTextFlow {
  /** Flow view for a message id; undefined renders the full text settled. */
  readonly flowFor: (messageId: string) => TextFlowView | undefined;
  /** Reveals everything immediately; call when the user submits. */
  readonly flush: () => void;
  /** True while the visible prefix trails the buffered text ("typing…"). */
  readonly revealing: boolean;
}

export function useTrailingTextFlow(
  lastMessage: AuniUiMessage | undefined,
  streaming: boolean,
): TrailingTextFlow {
  const trailing = lastMessage?.role === "assistant" ? lastMessage : undefined;
  const messageId = trailing?.id ?? null;
  const streamActive = streaming && trailing !== undefined;
  const text = trailing ? messageText(trailing) : "";

  const machineRef = useRef<FlowMachine>({
    commitFrame: null,
    commitSetter: null,
    messageId: null,
    state: null,
    text: "",
    timer: null,
  });
  const [snapshot, setSnapshot] = useState<FlowSnapshot | null>(null);

  const flush = useCallback(() => {
    const machine = machineRef.current;
    if (machine.state !== null) {
      // Direct commit: flush runs from user events and visibility changes,
      // never from the passive-effect chain.
      applyResult(machine, flushFlow(machine.state, machine.text));
      commitSnapshot(machine, setSnapshot);
    }
  }, []);

  useEffect(() => {
    const machine = machineRef.current;
    if (machine.messageId !== messageId) {
      // Leaving a message mid-flow (new turn, thread switch): it is done
      // flowing forever, a later remount must render it instantly.
      if (machine.messageId !== null) flowedMessageIds.add(machine.messageId);
      clearFlowTimer(machine);
      machine.messageId = messageId;
      machine.state = null;
      machine.text = "";
      scheduleCommit(machine, setSnapshot);
    }
    if (messageId === null) return;

    if (machine.state === null) {
      // Engage only for a message streaming live while mounted: history
      // replay and completed-message swaps render instantly.
      if (!streamActive || flowedMessageIds.has(messageId)) return;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        flowedMessageIds.add(messageId);
        return;
      }
      machine.state = createTextFlow();
    }

    machine.text = text;
    applyResult(
      machine,
      flowTextChanged(machine.state, { finalized: !streamActive, nowMs: Date.now(), text }),
    );
    scheduleCommit(machine, setSnapshot);
  }, [messageId, streamActive, text]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [flush]);

  useEffect(() => {
    const machine = machineRef.current;
    return () => {
      clearFlowTimer(machine);
      if (machine.commitFrame !== null) {
        window.cancelAnimationFrame(machine.commitFrame);
        machine.commitFrame = null;
      }
      if (machine.messageId !== null) flowedMessageIds.add(machine.messageId);
    };
  }, []);

  const active = snapshot !== null && snapshot.messageId === messageId;
  const view = active ? snapshot.view : undefined;
  const revealing = active && snapshot.revealing;
  const flowFor = useCallback(
    (id: string) => (active && id === messageId ? view : undefined),
    [active, messageId, view],
  );
  return useMemo(() => ({ flowFor, flush, revealing }), [flowFor, flush, revealing]);
}

type SnapshotSetter = React.Dispatch<React.SetStateAction<FlowSnapshot | null>>;

/** Stores a machine transition and re-arms the single flow timer it asked for. */
function applyResult(machine: FlowMachine, result: TextFlowResult): void {
  machine.state = result.state;
  clearFlowTimer(machine);
  if (result.timerDelayMs !== null) {
    machine.timer = window.setTimeout(() => {
      machine.timer = null;
      if (machine.state !== null) {
        applyResult(
          machine,
          flowTimerFired(machine.state, { nowMs: Date.now(), text: machine.text }),
        );
        // Timer callbacks are macrotasks, outside the effect chain: commit
        // directly so drain ticks and grace expiry land without frame lag.
        if (machine.commitSetter) commitSnapshot(machine, machine.commitSetter);
      }
    }, result.timerDelayMs);
  }
}

/** Coalesces snapshot commits from the delta effect into one per frame. */
function scheduleCommit(machine: FlowMachine, setSnapshot: SnapshotSetter): void {
  machine.commitSetter = setSnapshot;
  if (machine.commitFrame !== null) return;
  machine.commitFrame = window.requestAnimationFrame(() => {
    machine.commitFrame = null;
    commitSnapshot(machine, setSnapshot);
  });
}

function commitSnapshot(machine: FlowMachine, setSnapshot: SnapshotSetter): void {
  if (machine.state === null || machine.messageId === null) {
    setSnapshot(null);
    return;
  }
  if (isFlowComplete(machine.state, machine.text)) {
    // Flow complete: this id renders instantly forever after.
    flowedMessageIds.add(machine.messageId);
    machine.state = null;
    setSnapshot(null);
    return;
  }
  const flowedId = machine.messageId;
  const view: TextFlowView = {
    animating: isAnimating(machine.state, machine.text),
    visibleLength: machine.state.frontier,
  };
  const revealing = isFlowing(machine.state, machine.text);
  setSnapshot((current) =>
    current !== null &&
    current.messageId === flowedId &&
    current.revealing === revealing &&
    current.view.visibleLength === view.visibleLength &&
    current.view.animating === view.animating
      ? current
      : { messageId: flowedId, revealing, view },
  );
}

function clearFlowTimer(machine: FlowMachine): void {
  if (machine.timer !== null) {
    window.clearTimeout(machine.timer);
    machine.timer = null;
  }
}
