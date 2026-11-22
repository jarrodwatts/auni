import { getToolName, isToolUIPart } from "ai";

import {
  messageActivityParts,
  type AuniReasoningPart,
  type AuniToolPart,
  type AuniUiMessage,
} from "@/lib/conversation";
import { toolActivityTitle } from "@/lib/tool-copy";

/**
 * What a live answer is doing, for the line over its work: the step it is
 * running, the words it is writing, or between steps, the newest sentence of
 * its thought. With its thinking hidden, a thought is only "Thinking…". Null
 * before anything has happened.
 */
export function answerWorkingLabel(
  message: AuniUiMessage,
  { showThinking }: { readonly showThinking: boolean },
): string | null {
  const steps = toolSteps(message);
  const running = stepUnderWay(message);
  if (running) return `${toolActivityTitle(getToolName(running), running.state)}…`;
  const latest = latestStep(message);
  if (latest?.type === "text") return "Writing…";
  if (latest?.type === "data-reasoning") {
    return showThinking ? latestSentence(latest.data.text) : "Thinking…";
  }

  // Nothing is running: the model is reading the last result and choosing
  // its next step, which the stream announces the moment it names a tool.
  const last = steps.at(-1);
  if (!last) return null;
  return last.state === "output-error" || last.state === "output-denied"
    ? "Reviewing what happened…"
    : "Reading what came back…";
}

/** The step a live answer is running, which its label then names. */
export function stepUnderWay(message: AuniUiMessage): AuniToolPart | undefined {
  return toolSteps(message).findLast(
    ({ state }) => state === "input-streaming" || state === "input-available",
  );
}

function toolSteps(message: AuniUiMessage): AuniToolPart[] {
  return messageActivityParts(message).filter(
    (part): part is AuniToolPart => part.type !== "data-reasoning",
  );
}

/** The thought the agent is in the middle of: nothing has followed it yet. */
export function currentThought(message: AuniUiMessage): AuniReasoningPart | undefined {
  const latest = latestStep(message);
  return latest?.type === "data-reasoning" ? latest : undefined;
}

function latestStep(message: AuniUiMessage) {
  return message.parts.findLast(
    (part) => part.type === "text" || part.type === "data-reasoning" || isToolUIPart(part),
  );
}

/** A thought's sentences. */
const sentences = (text: string) => text.trim().split(/(?<=[.!?])\s+/u);

/** A thought is the model's own working; while it runs, its newest sentence is enough. */
function latestSentence(text: string): string {
  return sentences(text).at(-1) ?? text;
}

/** A thought gone by reads as its first sentence, what it set out to do; its whole is a tap away. */
export function firstSentence(text: string): string {
  return sentences(text)[0] ?? text;
}
