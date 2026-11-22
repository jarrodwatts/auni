import { textAsMeant } from "@auni/shared";
import { z } from "zod";

import { defineTool, failure, result, type AuniTool, type ToolTurn } from "../agent/tool.ts";
import { publishThread } from "../conversation/threads.ts";
import type { AutomationRow } from "../db/schema.ts";
import { OutOfCredits, WatchRefused } from "../apps/contract.ts";
import { offered, sources, type InstalledSource } from "../apps/registry.ts";
import {
  automationCard,
  automationById,
  automationWire,
  createAutomation,
  currentStatus,
  deleteAutomation,
  durationMs,
  durationSchema,
  editAutomation,
  listAutomations,
  type WatchFields,
} from "./automations.ts";

/** The sources the agent may watch with on this machine now. */
function readySources(): InstalledSource[] {
  return sources(offered()).filter(({ source }) => source.configured());
}

/** Each source's own words and its condition's shape, so the agent writes it as the source reads it. */
function sourceGuide({ about, source }: InstalledSource): string {
  const schema = z.toJSONSchema(source.condition, { unrepresentable: "any" });
  // Which JSON Schema dialect it is tells the agent nothing.
  delete schema.$schema;
  return `## source "${about.id}" (${about.name})\n${source.guide}\ncondition, as JSON Schema: ${JSON.stringify(schema)}`;
}

/** The first sentence of a source's guide: what it watches, and what that costs. */
function firstSentence(guide: string): string {
  return /^.*?[.!?](?=\s|$)/su.exec(guide)?.[0] ?? guide.split("\n")[0]!;
}

/**
 * The watch tool's description. Each source is a line here and its whole guide an answer away
 * (action guide), so the description stays within what every brain shows of it however many
 * sources are installed: Claude Code cuts a tool's description at 4,096 characters, and two
 * sources' guides and schemas came to 7,839, which cut the second source's off entirely.
 */
function watchDescription(ready: readonly InstalledSource[]): string {
  return `Set up, change or delete a watch. When its condition comes true (a time asked for always wakes you), a quick triage weighs the fire against its note, their holdings and its earlier fires, and either wakes you in this thread now, holds it for their daily brief, or just notes it; the note is what it judges by, so say in it what would make a fire matter. Woken, you take a turn as for any message: tell the owner, propose a move under their permission mode, or settle_quietly when it turns out nothing is worth saying.

action create takes source, condition, description (the plain-language line the owner sees in their watch list, "ETH falls below $2,000", never the condition's syntax) and note (for you when it fires: why it matters to them and what you meant to do, "they want to add to ETH under $2,000"). By default a watch fires once, or each time on a schedule; repeat (a cooldown such as "1h", or "0" for none) keeps it firing each time the condition comes true again, at most once per cooldown and once per story. expires_in ends it after that long ("24h", "7d"); without it, it watches until deleted. action edit takes watch_id and any of those to change (repeat "once" or expires_in "never" to clear one); action delete takes watch_id.

Ongoing check-ins: when a thread builds a position or tracks a belief, you can set watches in this thread for key news, major price moves, or scheduled reviews. Whenever holdings in a thread change, keep its watches aligned: watch new holdings and edit or delete watches that no longer fit. Tell the owner plainly what you'll speak up about; they can pause or delete any watch from the thread panel.

Each source below watches one kind of thing and reads its own shape of condition. Before your first watch on a source in this conversation, call action guide with that source: it answers with how to write its condition, with examples. A condition a source can't read is refused with its guide; reshape it and retry.
${ready.map(({ about, source }) => `- source "${about.id}" (${about.name}): ${firstSentence(source.guide)}`).join("\n")}`;
}

const repeatSchema = z.union([z.literal("once"), durationSchema]);
const expirySchema = z.union([z.literal("never"), durationSchema]);

function repeatOf(value: z.infer<typeof repeatSchema>): string | null {
  return value === "once" ? null : value;
}

/**
 * A new or changed condition's cooldown when the agent gave none: none for one that comes true
 * again and again by itself (a schedule), so it keeps firing; otherwise it fires once.
 */
function repeatFor(installed: InstalledSource, condition: Record<string, unknown>): string | null {
  return installed.source.recurs?.(condition) ? "0" : null;
}

function expiryOf(value: z.infer<typeof expirySchema>): Date | null {
  return value === "never" ? null : new Date(Date.now() + durationMs(value));
}

/** The condition as its source takes it, or why not; the source's own check runs too. */
async function parseCondition(
  installed: InstalledSource,
  condition: unknown,
): Promise<Record<string, unknown>> {
  // The condition is read here, not by the MCP server, so text is read as meant here too.
  const parsed = textAsMeant(installed.source.condition).safeParse(condition);
  // Its whole guide, so the agent writes the next one right, whatever it saw of the description.
  if (!parsed.success)
    throw new WatchRefused(
      `${installed.about.name} can't read that condition: ${z.prettifyError(parsed.error)}\n\nWrite it as its guide says:\n${sourceGuide(installed)}`,
    );
  await installed.source.check?.(parsed.data);
  return parsed.data;
}

export function automationTools(context: ToolTurn): AuniTool[] {
  const ready = readySources();
  const sourceIds = ready.map(({ about }) => about.id);
  if (sourceIds.length === 0) return [];

  const watch = defineTool({
    name: "watch",
    description: watchDescription(ready),
    inputSchema: {
      action: z.enum(["guide", "create", "edit", "delete"]),
      watch_id: z.uuid().optional(),
      source: z.enum(sourceIds as [string, ...string[]]).optional(),
      condition: z.record(z.string(), z.unknown()).optional(),
      description: z.string().trim().min(1).max(120).optional(),
      note: z.string().trim().min(1).max(500).optional(),
      repeat: repeatSchema.optional(),
      expires_in: expirySchema.optional(),
    },
    async handler(input) {
      try {
        if (input.action === "guide") {
          const installed = ready.find(({ about }) => about.id === input.source);
          if (!installed) return failure(new Error("guide takes source."));
          return result(sourceGuide(installed));
        }
        if (input.action === "create") {
          const installed = ready.find(({ about }) => about.id === input.source);
          if (!installed || !input.condition || !input.description || !input.note)
            return failure(new Error("create takes source, condition, description and note."));
          const condition = await parseCondition(installed, input.condition);
          const row = await createAutomation({
            threadId: context.threadId,
            source: installed.about.id,
            condition,
            description: input.description,
            note: input.note,
            repeat: input.repeat ? repeatOf(input.repeat) : repeatFor(installed, condition),
            expiresAt: input.expires_in ? expiryOf(input.expires_in) : null,
          });
          void publishThread(context.threadId);
          return watching(row, "Watching", installed);
        }

        const row = input.watch_id ? await automationById(input.watch_id) : undefined;
        if (!row || row.status === "deleted") return failure(new Error("No such watch."));
        if (input.action === "delete") {
          const deleted = await deleteAutomation(row);
          void publishThread(deleted.threadId);
          return result(`Deleted: ${deleted.description}.`, {
            automation: automationWire(deleted),
          });
        }

        const installed = ready.find(({ about }) => about.id === row.source);
        if (!installed) return failure(new Error(`${row.source} can't watch on this machine now.`));
        const condition = input.condition
          ? await parseCondition(installed, input.condition)
          : undefined;
        const changes: Partial<WatchFields> = {
          ...(condition ? { condition } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.note ? { note: input.note } : {}),
          ...(input.repeat
            ? { repeat: repeatOf(input.repeat) }
            : condition && installed.source.recurs
              ? { repeat: repeatFor(installed, condition) }
              : {}),
          ...(input.expires_in ? { expiresAt: expiryOf(input.expires_in) } : {}),
        };
        if (Object.keys(changes).length === 0) return failure(new Error("Nothing to change."));
        return watching(await editAutomation(row, changes), "Changed", installed);
      } catch (error) {
        if (error instanceof OutOfCredits) return failure(new Error(outOfCredits(input.source)));
        return failure(error);
      }
    },
  });

  const list = defineTool({
    name: "list_watches",
    description:
      "The owner's watches (all threads), newest first, with status: active, paused (the owner switched it off; only they turn it back on), triggered (done: it fired once), expired, or failed (its source stopped taking it). Pass thread_id to narrow to one thread.",
    inputSchema: { thread_id: z.uuid().optional() },
    async handler(input) {
      try {
        const rows = await listAutomations({
          ...(input.thread_id ? { threadId: input.thread_id } : {}),
        });
        const automations = rows.map(automationWire);
        return result(JSON.stringify(automations), { automations });
      } catch (error) {
        return failure(error);
      }
    },
  });

  return [watch, list];
}

/** Why a source took no new watch: its account is out of credits, which the owner must hear. */
function outOfCredits(source: string | undefined): string {
  const name = readySources().find(({ about }) => about.id === source)?.about.name ?? "That source";
  return `${name} is out of credits, so no watch was set: it can't watch anything until its account is topped up. Tell the owner so plainly; another source above may watch this instead.`;
}

/** What the agent is told of a watch it set up or changed, as its status now stands. */
function watching(row: AutomationRow, said: string, { about, source }: InstalledSource) {
  const status = currentStatus(row);
  // Credits running out under a watch already set only delays it, but the owner must know it
  // isn't watching meanwhile.
  const waiting =
    source.remote && !row.sourceRef
      ? ` But ${about.name} is out of credits, so it isn't watching yet: tell the owner, and that it starts by itself once the account is topped up.`
      : "";
  const now =
    status === "active"
      ? ` You'll be woken in this thread when it fires.${waiting}`
      : status === "paused"
        ? " It stays paused: the owner switched it off, and only they turn it back on."
        : ` It has ended (${status}), so it won't fire; set up a new watch to keep watching.`;
  return result(`${said}: ${row.description} (watch ${row.id}).${now}`, {
    automation: automationWire(row),
    card: automationCard(row),
  });
}
