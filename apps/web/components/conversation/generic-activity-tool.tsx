"use client";

import type { ToolUIPart } from "ai";
import { Wrench } from "lucide-react";

import { ActivityRow } from "@/components/conversation/activity-row";
import { SiteMarks } from "@/components/conversation/site-marks";
import {
  TOOL_ICONS,
  TOOL_INPUT_DETAIL_KEYS,
  toolStepStatus,
} from "@/components/conversation/generic-activity-copy";
import { toolActivityTitle } from "@/lib/tool-copy";
import { stepSites } from "@/lib/sources";
import { toolResult } from "@/lib/tool-results";

/** One step in the timeline: what the tool is doing in the person's words, how it went, and what it found. */
export function GenericActivityTool({
  input,
  live,
  output,
  state,
  toolName,
}: {
  readonly input?: unknown;
  /** The turn is still running, so a step without its output is under way. */
  readonly live: boolean;
  readonly output?: unknown;
  readonly state: ToolUIPart["state"];
  readonly toolName: string;
}) {
  const status = toolStepStatus(state, live);
  const Icon = TOOL_ICONS[toolName] ?? Wrench;
  const done = state === "output-available";

  return (
    <>
      <ActivityRow
        detail={status === "failed" ? null : toolInputDetail(toolName, input)}
        icon={<Icon className="size-3.5" aria-hidden />}
        result={done ? toolResult(toolName, output) : null}
        status={status}
        swap
        text={toolActivityTitle(toolName, state)}
      />
      {/* A web step names the sites it read, as soon as it has them. */}
      {done ? <SiteMarks sites={stepSites(toolName, input, output)} /> : null}
    </>
  );
}

function toolInputDetail(toolName: string, input: unknown): string | null {
  const key = TOOL_INPUT_DETAIL_KEYS[toolName];
  if (!key || !input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 240) : null;
}
