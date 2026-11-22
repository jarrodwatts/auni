/**
 * Someone else's words as JSON inside `<tag>`, for the agent to read as data.
 * Angle brackets become JSON escapes, so nothing inside can close the fence,
 * and a cut to `maxChars` still leaves it closed.
 */
export function fenced(tag: string, data: unknown, maxChars = Infinity): string {
  const json = JSON.stringify(data).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `<${tag}>${json.slice(0, maxChars)}</${tag}>`;
}
