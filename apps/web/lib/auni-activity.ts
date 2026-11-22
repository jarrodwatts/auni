type AuniActivityMood = "color" | "thinking" | "executing" | "sad";

interface ToolActivityLike {
  readonly state: string;
}

export function auniActivityMood(input: {
  readonly activities: readonly ToolActivityLike[];
  readonly streaming: boolean;
  readonly text: string;
}): AuniActivityMood {
  if (!input.streaming || input.text.length > 0) return "color";

  const latest = input.activities.at(-1);
  if (!latest) return "thinking";
  if (latest.state === "input-streaming" || latest.state === "input-available") {
    return "executing";
  }
  if (latest.state === "output-error") return "sad";
  return "thinking";
}
