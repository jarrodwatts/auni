import { ASK_LINE, listed, SOLANA_BRING_FIELD } from "@auni/shared";
import { z } from "zod";

import { AskRefused, recordAsk } from "../asks.ts";
import { noSolanaBring } from "../money/wallets.ts";
import { privateFields } from "../private-fields.ts";
import { plainWords } from "./plain-words.ts";
import { defineTool, failure, result, type ToolTurn } from "./tool.ts";

const whySchema = plainWords(200).min(10);

/**
 * Any agent may ask for a secret core takes in one of its private fields, by the field's id
 * alone: core words the card, and the value goes from the owner's browser to core and never back
 * (routes/private.ts). The agent hears only that it was saved, or that the owner said no.
 */
export function requestSecretTool(turn: ToolTurn) {
  return defineTool({
    name: "request_secret",
    description:
      "Ask the owner for a secret Auni takes in a private field of its own: an app's key, a " +
      `Solana private key they already hold (${SOLANA_BRING_FIELD}, for a wallet with no Solana address), ` +
      "or the code a sign-in waits on. A card under your reply names it, carries your one " +
      "sentence on why, and holds a hidden field they paste it into, which goes straight to Auni " +
      "on this computer: you never see it. Ask when it would help with what they asked, one card " +
      "at a time. When they save it you're woken here and told so, and nothing more: carry on " +
      "with what you needed it for, without asking them again. If they say no you're told; then " +
      "don't offer it again soon, and never ask for it in the chat. Never ask for a key, a code " +
      "or a password in the chat at all: one pasted there is kept from you and offered this " +
      "card. Its field is filled in only in the Auni app; on a chat app the card links there.",
    inputSchema: {
      field: z
        .string()
        .describe(
          `The field's id: keys:<app id> for an app's keys, as "Apps you could offer" names it, ${SOLANA_BRING_FIELD} for a Solana key they hold, or one a failure lists.`,
        ),
      why: whySchema.describe(
        "One sentence, in your own words, on what it would let you do for what they just asked.",
      ),
    },
    async handler(input) {
      const { field: id, why } = z.object({ field: z.string(), why: whySchema }).parse(input);
      const fields = await privateFields();
      const field = fields.find((each) => each.id === id);
      if (!field) {
        const instead = id === SOLANA_BRING_FIELD ? await noSolanaBring() : null;
        const takes = fields.length
          ? `It takes ${listed(fields.map((each) => `${each.id} (${each.label})`))}.`
          : "It takes none now.";
        return failure(
          `No card was made: Auni takes no secret by the field "${id}" now. ${instead ?? takes}`,
        );
      }
      try {
        const { card } = await recordAsk(
          turn,
          "request_secret",
          { field: id, app: field.app, why },
          { summary: field.label, lines: [{ label: ASK_LINE.why, value: why }] },
        );
        const proof = field.proof
          ? " Saving it takes proof the owner is at this computer, which the card asks for first."
          : "";
        return result(
          `Nothing is saved yet: the card under your reply asks the owner for their ${field.label}.${proof} You'll be woken here when they save it or say no.`,
          { card },
        );
      } catch (error) {
        if (error instanceof AskRefused) return failure(error.message);
        throw error;
      }
    },
  });
}
