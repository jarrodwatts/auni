import { randomUUID } from "node:crypto";

import { FEEDBACK_KINDS, type feedbackCardSchema } from "@auni/shared";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { db } from "../db/client.ts";
import { actions } from "../db/schema.ts";
import { appRequest, bugReport, idea } from "../feedback.ts";
import { defineTool, failure, result, type ToolTurn } from "./tool.ts";

const says = z
  .string()
  .trim()
  .min(10)
  .max(300)
  .regex(/^[^\n\r]*$/u, "one sentence, on one line");

const input = {
  kind: z
    .enum(FEEDBACK_KINDS)
    .describe(
      "app: ask for an app for a service Auni has none for. bug: report something broken. idea: suggest something.",
    ),
  says: says.describe(
    'One sentence in plain words. app: what the owner asked for ("Stake MON with Kintsu"). bug: what they expected and what happened. idea: the idea. Never an amount, a balance or an address: it is posted in public.',
  ),
  about: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .optional()
    .describe(
      'app: the service\'s name as people know it ("Lido"), needed. bug: the id of the app it is about, when it is about one.',
    ),
  site: z.string().trim().min(1).max(100).optional().describe('app: its website ("lido.fi").'),
  action_id: z
    .uuid()
    .optional()
    .describe("bug: the move in this thread that failed, when it is about one."),
};

/**
 * The agent's way to let the owner tell Auni's maintainer something. It records nothing and
 * changes nothing: it returns a card that shows what would be posted, built by core from its own
 * records (feedback.ts), and the owner posts it themselves on GitHub, or doesn't.
 */
export function sendFeedbackTool(turn: ToolTurn) {
  return defineTool({
    name: "send_feedback",
    description:
      "Put a card under your reply that lets the owner tell Auni's maintainer something: ask " +
      "for an app for a service Auni has none for, report something broken, or suggest " +
      "something. Auni is open source, and one person maintains it. The owner posts the card " +
      "themselves, as a public issue on Auni's GitHub under their own GitHub name, so say it " +
      'that way: never a team, a support desk or "we". The card shows them exactly what would ' +
      "be posted, with anything that could point at their wallet left off until they tick it, " +
      "and one button opens GitHub's form filled in. Auni sends nothing itself. Use it when they " +
      'ask ("can you add Lido?", "tell them this is broken"), and at most once after a ' +
      "transaction you built for a service with no app went through, if you judge they would " +
      "want that service to work better here. These cards are rare: never one on every move.",
    inputSchema: input,
    async handler({ kind, says: said, about, site, action_id }) {
      const card = (feedback: Awaited<ReturnType<typeof idea>>) =>
        result(
          "Nothing is posted: the card under your reply shows the owner what would be, and only they can post it, as a public issue on Auni's GitHub under their own GitHub name, where Auni's maintainer reads it. Mention the card in a sentence.",
          {
            card: {
              id: randomUUID(),
              kind: "feedback",
              title: feedback.heading,
              updatedAt: new Date().toISOString(),
              feedback,
            } satisfies z.input<typeof feedbackCardSchema>,
          },
        );
      if (kind === "idea") return card(await idea(said));
      if (kind === "app") {
        if (!about) return failure("No card was made: name the service in `about`.");
        return card(await appRequest(turn.threadId, { name: about, site, asked: said }));
      }
      // Only a move of this thread: nothing from another conversation reaches a card here.
      const [action] = action_id
        ? await db
            .select()
            .from(actions)
            .where(and(eq(actions.id, action_id), eq(actions.threadId, turn.threadId)))
        : [];
      if (action_id && !action)
        return failure("No card was made: no move in this thread has that id.");
      return card(await bugReport({ happened: said, action, app: about }));
    },
  });
}
