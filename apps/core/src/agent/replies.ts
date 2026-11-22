import { suggestRepliesInputSchema, type ReplyOption } from "@auni/shared";

import { wroteSinceLastStep } from "../conversation/turn-record.ts";
import { defineTool, failure, type ToolTurn } from "./tool.ts";

function echo({ label, hint }: ReplyOption): string {
  return hint ? `${label} (${hint})` : label;
}

/**
 * What the owner can see so far, which the agent loses track of: a reply drafted only in its
 * thinking left them a bare "just tap one" under the picker, and one written before the call was
 * written again after it. Core knows, so it says; a fact, as the agent rightly doubts orders that
 * come back in a tool's result, and its description says what to do with it.
 */
function seen(threadId: string): string {
  return wroteSinceLastStep(threadId)
    ? "The owner can see your reply, with these options under it."
    : "The owner has seen no words from you yet this turn, only these options.";
}

/** A question with tappable answers; the web docks it above the reply box from this call's input. */
export const suggestRepliesTool = (turn: Pick<ToolTurn, "threadId">) =>
  defineTool({
    name: "suggest_replies",
    description:
      "Ask the owner a question that has a few natural answers. It shows as a picker under your " +
      "reply, the text you write this turn. Its result says what the owner can see so far: when " +
      "they've seen no words from you yet, write your whole reply next, as a reply drafted only " +
      "in your thinking never reaches them; when your reply is showing, end the turn without " +
      "writing more. Don't repeat the question in the reply. " +
      '2 to 4 options, each a short `label` in the owner\'s own voice ("A year or two", "Keep ' +
      'it safe"), under 40 characters, with an optional `hint` under 60 characters saying what ' +
      "choosing it means; a hint never repeats its label. Set `multiple` only when several " +
      "answers genuinely combine. Picking sends the label (several join into one sentence) as " +
      "their message; they can still type anything. Leave `question` out when the options are " +
      "not answers but the next things they might say: they show as one row of buttons, the " +
      "first as the main one, so put the likeliest first, and one option is enough. Never use " +
      "it to confirm moving money: the money card does that.",
    inputSchema: suggestRepliesInputSchema.shape,
    // The history keeps what was asked, so later turns can see it.
    handler({ question, options, multiple }) {
      if (question && options.length < 2)
        return Promise.resolve(failure("A question takes at least two options."));
      const offered = options.map(echo).join(" / ");
      const asked = question ? `Asked: ${question} Options: ${offered}` : `Offered: ${offered}`;
      const said = multiple ? `${asked} (pick any)` : asked;
      return Promise.resolve({
        content: [{ type: "text", text: `${said}. ${seen(turn.threadId)}` }],
      });
    },
  });
