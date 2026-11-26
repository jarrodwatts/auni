"use client";

import type { ToolUIPart } from "ai";
import { Wrench } from "lucide-react";

import { ActivityRow } from "@/components/conversation/activity-row";
import { SiteMarks } from "@/components/conversation/site-marks";
import {
  TOOL_ICONS,
  TOOL_INPUT_DETAIL_KEYS,
  toolAppId,
  toolStepStatus,
} from "@/components/conversation/generic-activity-copy";
import { hasMark, IntegrationMark } from "@/components/integrations/integration-mark";
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
  const done = state === "output-available";
  const found = done ? toolResult(toolName, output) : null;

  return (
    <>
      <ActivityRow
        detail={status === "failed" ? null : toolInputDetail(toolName, input)}
        icon={<ToolStepIcon size={18} toolName={toolName} />}
        result={found}
        status={status}
        swap
        text={toolActivityTitle(toolName, state)}
      />
      {/* A web step names the sites it read, as soon as it has them. */}
      {done ? <SiteMarks sites={stepSites(toolName, input, output)} /> : null}
    </>
  );
}

/** A tool's own icon: its app's mark when it belongs to an app, else its glyph. */
export function ToolStepIcon({
  size = 16,
  toolName,
}: {
  readonly size?: number;
  readonly toolName: string;
}) {
  const appId = toolAppId(toolName);
  if (appId && hasMark(appId)) {
    return <IntegrationMark integration={appId} size={size} />;
  }
  const Icon = TOOL_ICONS[toolName] ?? Wrench;
  return <Icon className="size-3.5" aria-hidden />;
}

function toolInputDetail(toolName: string, input: unknown): string | null {
  const key = TOOL_INPUT_DETAIL_KEYS[toolName];
  if (!key || !input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 240) : null;
}
