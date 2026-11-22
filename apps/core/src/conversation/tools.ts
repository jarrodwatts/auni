import { updateMeRequestSchema } from "@auni/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { defineTool, failure, result, type AuniTool, type ToolTurn } from "../agent/tool.ts";
import {
  briefPreview,
  briefWhen,
  heldFires,
  nextBrief,
  releaseHeld,
} from "../automations/brief.ts";
import { onTheirClock, SCHEDULE_SHAPES, scheduleSchema } from "../automations/schedule.ts";
import { theOwner } from "../auth/owner.ts";
import { canBeHome, homeChannel, pairedChannels, type PairedChannel } from "../channels/home.ts";
import { db } from "../db/client.ts";
import { owner, threads, type OwnerRow } from "../db/schema.ts";
import { postgresKnowsZone } from "../money/value-history.ts";
import { firstSpoke, titledByStart } from "./places.ts";
import { publishThread, threadById } from "./threads.ts";

// Tools about the conversation itself rather than money or watches.

/**
 * Ends a background turn with nothing worth telling. The turn reads its call afterwards
 * (settledQuietly in turn.ts): the answer is kept for the agent's history, marked quiet, and the
 * owner isn't told.
 */
const settleQuietlyTool = defineTool({
  name: "settle_quietly",
  description:
    "When you were woken in the background (a watch fired, a move landed, the brief) and " +
    "nothing in it is worth the owner's attention, call this with a one-line reason and write " +
    "nothing more: the owner isn't told, and a watch's fire records your reason as what came of " +
    "it. Never use it to answer something the owner sent.",
  inputSchema: { reason: z.string().trim().min(1).max(300) },
  handler: ({ reason }) =>
    Promise.resolve(result(`Settled quietly: ${reason}. Write nothing more.`)),
});

/** When their next brief comes, in plain words, for the agent to promise nothing else. */
function nextSaid(next: Date | null, now: Date, timeZone: string): string {
  if (!next) return "";
  // The brief job looks every five minutes (briefJob), so a brief comes up to five minutes late.
  if (next <= now) return " The next is due now, and comes within five minutes.";
  return ` The next comes ${onTheirClock(next.getTime(), timeZone)}, or within five minutes after.`;
}

function noticesNow(
  me: Pick<OwnerRow, "brief" | "timeZone" | "homeChannel">,
  next: Date | null,
  now: Date,
  home: string | null,
  paired: readonly PairedChannel[],
): string {
  const brief = me.brief
    ? `Their brief comes ${briefWhen(me.brief)}, their time.${nextSaid(next, now, me.timeZone)}`
    : "They have no brief.";
  const nameOf = (id: string | null) =>
    paired.find((channel) => channel.id === id)?.name ?? "the web app alone";
  const follows = me.homeChannel ? "as they chose" : "where they last talked to you";
  const others = paired.length
    ? `Paired: ${paired.map(({ id, name }) => `${name} (${id})`).join(", ")}.`
    : "No chat app is paired.";
  return (
    `${brief} Their time zone is ${me.timeZone}, where it is ${onTheirClock(now.getTime(), me.timeZone)} now. ` +
    `What you say unasked goes to ${nameOf(home)}, ${follows}, and always to the web app. ${others}`
  );
}

/**
 * Their brief as it would read now, when they ask to see it: what it is written from, which uses
 * up nothing, so the next brief still comes when it is due and tells what was held.
 */
const showBriefTool = defineTool({
  name: "show_brief",
  description:
    'When the owner asks to see their brief now ("what would my brief say?", "show me my ' +
    'brief"), call this and write it in your answer from what it returns. It is a look, not ' +
    "their brief: the next one still comes when set_notices says, and what your watches held " +
    "for it stays held. Never move their brief to see it sooner.",
  inputSchema: {},
  async handler() {
    try {
      const me = await theOwner();
      return result(briefPreview(await heldFires(db), new Date(), me.timeZone));
    } catch (error) {
      return failure(error);
    }
  },
});

/** When and whether the brief comes, and the time zone their day runs in. */
const setNoticesTool = defineTool({
  name: "set_notices",
  description:
    "Read or change how Auni speaks up unasked. Their brief is one short turn in Auni's chat " +
    "(their newest chat outside every specialist), every day at 8:00 am unless they ask " +
    "otherwise: how their money and specialists moved, and what your watches held for it " +
    "rather than waking you. Each of its times comes once, so one moved later today comes " +
    "again today; what this answers says when the next one comes, so promise no other time. " +
    "To show them a brief now, use show_brief. brief sets when it " +
    "comes, on their own clock, as one of these:\n" +
    SCHEDULE_SHAPES +
    "\nor null stops it, and what was held for it goes back to be judged again. time_zone " +
    'sets theirs (an IANA name such as "Europe/London") when they tell you where they are. ' +
    "What you say unasked (the brief, a move landing, a watch " +
    'waking you) reaches the web app and their home chat app: home "last_used" follows ' +
    'wherever they last talked to you, "web" keeps it to the web app, or a paired ' +
    "channel's id picks that one. Call it with nothing to read the settings.",
  inputSchema: {
    brief: z.union([scheduleSchema, z.null()]).optional(),
    time_zone: z.string().max(100).optional(),
    home: z.string().max(64).optional(),
  },
  async handler(input) {
    try {
      let timeZone: string | undefined;
      if (input.time_zone !== undefined) {
        const parsed = updateMeRequestSchema.safeParse({ time_zone: input.time_zone });
        timeZone = parsed.success ? parsed.data.time_zone : undefined;
        if (!timeZone || !(await postgresKnowsZone(timeZone)))
          return failure(new Error(`${input.time_zone} isn't a time zone Auni knows.`));
      }
      const paired = await pairedChannels();
      const home = input.home === "last_used" ? null : input.home;
      if (home !== undefined && !canBeHome(home, paired))
        return failure(
          new Error(`${input.home} isn't a paired channel; auni pair --channel <id> pairs one.`),
        );
      const changes = {
        ...(input.brief !== undefined ? { brief: input.brief } : {}),
        ...(timeZone ? { timeZone } : {}),
        ...(home !== undefined ? { homeChannel: home } : {}),
      };
      const me =
        Object.keys(changes).length > 0
          ? await db.transaction(async (tx) => {
              await tx.update(owner).set(changes);
              if (input.brief === null) await releaseHeld(tx);
              return theOwner(tx);
            })
          : await theOwner();
      const sendsTo = await homeChannel();
      const now = new Date();
      const next = nextBrief(me, now, await firstSpoke());
      return result(noticesNow(me, next, now, sendsTo, paired), {
        brief: me.brief,
        next_brief: next?.toISOString() ?? null,
        time_zone: me.timeZone,
        home: me.homeChannel ?? "last_used",
        sends_to: sendsTo ?? "web",
        channels: paired,
      });
    } catch (error) {
      return failure(error);
    }
  },
});

/**
 * Names the chat the turn is in, once, when its first message's words don't say what it is about.
 * A name the owner gave, or one already given this way, stays: the chat keeps one name.
 */
function nameChatTool(turn: ToolTurn) {
  return defineTool({
    name: "name_chat",
    description:
      "A new chat is titled by the owner's first message, cut near 48 characters. When those " +
      "words don't say what the chat is about (a greeting, a long message, or one that turned " +
      "into something else), give it a short name, 2 to 6 plain words the owner would " +
      'look for it by, such as "Nvidia buy" or "Daily brief time". Once named, by them or ' +
      "you, the name stays. Don't call it when the first message already says it.",
    inputSchema: { name: z.string().trim().min(2).max(48) },
    async handler({ name }) {
      const thread = await threadById(turn.threadId);
      if (!thread || thread.specialistId)
        return failure(new Error("A specialist's chat goes by the specialist's name."));
      if (!(await titledByStart(thread)))
        return failure(
          new Error(`This chat already has its name, "${thread.title}", which stays.`),
        );
      await db.update(threads).set({ title: name }).where(eq(threads.id, thread.id));
      void publishThread(thread.id);
      return result(`Named this chat "${name}".`);
    },
  });
}

export function conversationTools(turn: ToolTurn): AuniTool[] {
  return [settleQuietlyTool, setNoticesTool, showBriefTool, nameChatTool(turn)];
}
