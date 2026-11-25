import { ASK_LINE } from "@auni/shared";
import { z } from "zod";

import { appById } from "../apps/registry.ts";
import { AskRefused, recordAsk } from "../asks.ts";
import { connecting, connects, offerNamed } from "../connect.ts";
import { walletAddresses } from "../money/wallets.ts";
import { settingField } from "../settings.ts";
import { plainWords } from "./plain-words.ts";
import { defineTool, failure, result, type ToolTurn } from "./tool.ts";

const whySchema = plainWords(200).min(10);

/** Any agent may offer to turn an app back on; only the owner's tap does (asks.ts). */
export function connectAppTool(turn: ToolTurn) {
  return defineTool({
    name: "connect_app",
    description:
      'Offer to turn back on an app the owner turned off, from the list in "Apps you could offer": ' +
      "a card under your reply with the app's name, your one sentence on what it would add, and " +
      "its Turn on button beside Decline. Nothing changes until they tap it; when they do, you're " +
      "woken here with its tools and skill ready, so you can finish what they asked for. If they " +
      "say no, you're told. An app that needs a key is asked for it with request_secret instead.",
    inputSchema: {
      app: z.string().describe("The app's id, as listed: the word before the bracket."),
      why: whySchema.describe(
        "One sentence, in your own words, on what it would add for what they just asked.",
      ),
    },
    async handler(input) {
      const { app: id, why } = z.object({ app: z.string(), why: whySchema }).parse(input);
      const app = appById(id);
      if (!app)
        return failure(`No app here is called "${id}". Use an id from "Apps you could offer".`);
      const state = connecting(app, await walletAddresses().catch(() => null));
      if (state.kind === "no-card")
        return failure(`No card was made. ${state.why} Tell them that.`);
      if (state.kind === "nothing")
        return failure(`No card was made: ${app.about.name} is connected already.`);
      if (!state.turnsOn)
        return failure(
          `No card was made: ${app.about.name} is on, and needs its ${state.keys.join(" and ")}, which request_secret asks for in the field ${settingField(id)}.`,
        );
      try {
        const { card } = await recordAsk(
          turn,
          "connect_app",
          { app: id, why },
          {
            summary: offerNamed(app).title,
            lines: [
              { label: ASK_LINE.why, value: why },
              { label: ASK_LINE.changes, value: connects(app) },
            ],
          },
        );
        return result(
          `Nothing has changed yet: the card under your reply offers to turn ${app.about.name} on, and only the owner's tap does. You'll be woken here when they decide.`,
          { card },
        );
      } catch (error) {
        if (error instanceof AskRefused) return failure(error.message);
        throw error;
      }
    },
  });
}
