import { z } from "zod";

import { recordAsk } from "../asks.ts";
import {
  routineBodySchema,
  routineDescriptionSchema,
  routineNameSchema,
  routineOnDisk,
  routineTitle,
} from "./routines.ts";
import { isBuiltInSkill } from "./skills.ts";
import { defineTool, failure, result, type ToolTurn } from "./tool.ts";

/** Any agent may ask to keep a way of working; only the owner's tap saves it (see asks.ts). */
export function saveRoutineTool(turn: ToolTurn) {
  return defineTool({
    name: "save_routine",
    description:
      "Ask to save a way of working the owner wants repeated as their routine: a playbook you " +
      "and every specialist can load with load_skill from the next turn on. It shows the whole " +
      "text on a card, and nothing is saved until they tap Allow; they can read, edit or delete " +
      "it as a file afterwards. Write it as steps you'd follow, in plain words. Saving under the " +
      "name of one they have replaces it, and the card says so. When they want it run at a time or " +
      "on a schedule, also set a watch on the time in this same turn, its note naming the routine.",
    inputSchema: {
      name: routineNameSchema.describe('Lowercase words joined by hyphens: "check-rates".'),
      description: routineDescriptionSchema.describe(
        'When to load it, in one line: "Load when moving idle cash between savings markets."',
      ),
      body: routineBodySchema.describe("The routine itself."),
    },
    async handler(input) {
      const parsed = z
        .object({
          name: routineNameSchema,
          description: routineDescriptionSchema,
          body: routineBodySchema,
        })
        .parse(input);
      if (isBuiltInSkill(parsed.name))
        return failure(
          `Nothing was saved: ${parsed.name} is one of Auni's own skills. Pick another name.`,
        );
      // The card is bound to the file it replaces, if any, as it is now (see asks.ts).
      const replaces = routineOnDisk(parsed.name);
      const { card } = await recordAsk(
        turn,
        "save_routine",
        { ...parsed, replaces },
        {
          summary: `${replaces ? "Replace your routine" : "Save a routine"}: ${routineTitle(parsed.name)}`,
          lines: [
            { label: "When to use it", value: parsed.description },
            { label: "What it says", value: parsed.body },
          ],
        },
      );
      return result(
        "Nothing is saved yet: the card under your reply shows the whole routine, and the owner's tap saves it. Mention it in a sentence; don't repeat the routine.",
        { card },
      );
    },
  });
}
