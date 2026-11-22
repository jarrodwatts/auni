import {
  type askCardSchema,
  type ActionLine,
  type AskToolName,
  isAsk,
  listed,
  threadActModeSchema,
} from "@auni/shared";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  routineBodySchema,
  routineDescriptionSchema,
  routineNameSchema,
  routineOnDisk,
  routineTitle,
  writeRoutine,
} from "./agent/routines.ts";
import { isBuiltInSkill } from "./agent/skills.ts";
import type { ToolTurn } from "./agent/tool.ts";
import { appById } from "./apps/registry.ts";
import { connecting, offerNamed } from "./connect.ts";
import { db, type Tx } from "./db/client.ts";
import { actions, threads, type ActionRow } from "./db/schema.ts";
import { wakeThread } from "./jobs/kinds.ts";
import { begins, step } from "./money/life.ts";
import { lockCards } from "./money/pot.ts";
import { walletAddresses } from "./money/wallets.ts";
import { dollars } from "./money/summaries.ts";
import { PrivateFieldRefused } from "./private-fields.ts";
import { saveSwitch } from "./settings.ts";

// Cards that change Auni itself rather than move money. Each is an action row like a money card,
// so the one path that decides cards (money/decide.ts) decides these on every channel, and the
// agent can only ask: a tool records the row waiting, and only the owner's Allow applies it, in
// the transaction that allows it, so nothing is queued and nothing is left half done.

export { isAsk };

interface Ask<Input> {
  readonly input: z.ZodType<Input>;
  /**
   * Why no card of it may be recorded now, in words for the agent; asked while cards are
   * recorded one at a time, so two asks at once can't both pass.
   */
  blocked?(tx: Tx, input: Input): Promise<string | null>;
  /** Applies it in the allowing transaction; a string is why it can't, and nothing changed. */
  apply(tx: Tx, row: ActionRow, input: Input): Promise<string | null>;
  /**
   * The main button's words, named for what the tap does and how much, as a money card's are:
   * "Auto up to $500". Every surface that draws the card says these, never a bare "Allow".
   */
  action(input: Input): string;
}

/**
 * A button that names what it acts on, "Save Friday check", where that fits on one line of a
 * phone's button (18 characters); else `short`, "Replace routine".
 */
function naming(verb: string, name: string, short: string): string {
  const named = `${verb} ${name}`;
  return name && named.length <= 18 ? named : short;
}

/**
 * Widens how a thread acts (turning on Auto within a budget, or raising its dollar cap).
 * Only the owner's tap on the sealed card applies it.
 */
const setThreadAutonomy = defineAsk({
  input: z.object({
    thread_id: z.uuid(),
    act_mode: threadActModeSchema,
    budget_usd: z.string(),
  }),
  action: (input) =>
    input.act_mode === "within_limits"
      ? `Auto up to ${dollars(input.budget_usd)}`
      : "Switch to Ask first",
  async apply(tx, _row, input) {
    const [current] = await tx
      .select({ id: threads.id, archivedAt: threads.archivedAt })
      .from(threads)
      .where(eq(threads.id, input.thread_id))
      .for("update");
    if (!current) return "That thread is gone.";
    if (current.archivedAt) return "That thread was archived before you allowed this.";
    await tx
      .update(threads)
      .set({ actMode: input.act_mode, budgetUsd: input.budget_usd })
      .where(eq(threads.id, input.thread_id));
    return null;
  },
});

/**
 * A way of working the owner wants kept, saved as their routine (agent/routines.ts). Its whole
 * text is on the card, so the tap agrees to every word, and so is whether it replaces one: it
 * saves only over the file it was shown with (`replaces`, its digest, or null for none). The
 * check and the write run with nothing awaited between, and last, once nothing else in the
 * transaction can refuse it.
 */
const saveRoutine = defineAsk({
  input: z.object({
    name: routineNameSchema,
    description: routineDescriptionSchema,
    body: routineBodySchema,
    replaces: z.string().nullable(),
  }),
  action: ({ name, replaces }) =>
    replaces
      ? naming("Replace", routineTitle(name), "Replace routine")
      : naming("Save", routineTitle(name), "Save routine"),
  async apply(_tx, _row, { replaces, ...routine }) {
    if (isBuiltInSkill(routine.name)) return `${routine.name} is one of Auni's own skills.`;
    if (routineOnDisk(routine.name) !== replaces)
      return "Your routine changed since this card was shown, so nothing was saved. Ask again for a card that shows it now.";
    writeRoutine(routine);
    return null;
  },
});

/**
 * Auni's offer to turn back on an app the owner switched off (connect.ts). A key it lacks is no
 * part of it: request_secret asks for that. One whose switch couldn't be written fails with
 * nothing changed; only once the app is on is the thread woken to carry on with it.
 */
const connectApp = defineAsk({
  input: z.object({ app: z.string(), why: z.string().max(200) }),
  action: (input) => {
    const app = appById(input.app);
    return app ? offerNamed(app).button : "Turn on";
  },
  blocked: (tx, input) => waitingFor(tx, "connect_app", "app", input.app),
  async apply(tx, row, input) {
    const app = appById(input.app);
    if (!app) return "That app is no longer part of this Auni.";
    const state = connecting(app, await walletAddresses().catch(() => null));
    if (state.kind === "no-card") return state.why;
    if (state.kind === "card" && state.turnsOn) {
      try {
        await saveSwitch(app.about.id, true);
      } catch (error) {
        // The settings file couldn't be changed safely, or this computer's environment sets the list.
        if (!(error instanceof PrivateFieldRefused)) throw error;
        return error.message;
      }
    }
    const { name } = app.about;
    const needs = state.kind === "card" ? state.keys : [];
    if (row.threadId)
      await wakeThread(
        row.threadId,
        needs.length > 0
          ? `The owner allowed your card: ${name} is on again. It still needs its ${listed(needs)}.`
          : app.channel
            ? `The owner allowed your card: ${name} is on again. Their own chat there isn't paired with Auni yet, which they do under Apps in the Auni app.`
            : `The owner allowed your card: ${name} is on again, and its tools and its skill are yours from this turn on.`,
        { tx },
      );
    return null;
  },
});

/**
 * Auni asking for a secret the owner types into one of core's private fields (private-fields.ts):
 * an app's keys, a Solana key they hold, a sign-in code. The card draws the field, in the web app
 * alone, and the secret saved there is what allows it (secretSaved in money/decide.ts), never a
 * tap: so nothing can tell the agent it was given when it wasn't, and the agent hears that it was
 * saved and nothing more. Declined, it hears that, as of any card.
 */
const requestSecret = defineAsk({
  // The app is the field's (PrivateField.app), whose mark the card wears.
  input: z.object({
    field: z.string().max(200),
    app: z.string().max(100),
    why: z.string().max(200),
  }),
  action: () => "Save",
  blocked: (tx, input) => waitingFor(tx, "request_secret", "field", input.field),
  async apply(tx, row) {
    if (row.threadId)
      await wakeThread(
        row.threadId,
        `The owner saved their ${row.summary}, which your card asked for.`,
        { tx },
      );
    return null;
  },
});

/** Why no second card asking for the same thing is made while one waits; null when none does. */
async function waitingFor(
  tx: Tx,
  tool: "connect_app" | "request_secret",
  by: "app" | "field",
  value: string,
): Promise<string | null> {
  const [waiting] = await tx
    .select({ id: actions.id })
    .from(actions)
    .where(
      and(
        eq(actions.tool, tool),
        eq(actions.status, "awaiting_permission"),
        sql`${actions.input}->>${by} = ${value}`,
      ),
    )
    .limit(1);
  return waiting
    ? "No new card was made: one that asks for this is already waiting for the owner."
    : null;
}

/** Keeps each ask's own input type through the table below. */
function defineAsk<Input>(ask: Ask<Input>): Ask<Input> {
  return ask;
}

const ASKS = {
  set_thread_autonomy: setThreadAutonomy,
  save_routine: saveRoutine,
  connect_app: connectApp,
  request_secret: requestSecret,
} satisfies { readonly [Tool in AskToolName]: unknown };

type AskInput<Tool extends AskToolName> =
  (typeof ASKS)[Tool] extends Ask<infer Input> ? Input : never;

type AskCard = z.input<typeof askCardSchema>;

/** The card an ask's row shows: the row's own words, never anything the agent wrote after. */
function askCard(row: ActionRow): AskCard {
  if (!isAsk(row.tool)) throw new Error(`${row.tool} is not an ask.`);
  const ask = ASKS[row.tool] as Ask<unknown>;
  return {
    id: row.id,
    kind: "ask",
    title: row.summary.slice(0, 160),
    updatedAt: row.updatedAt.toISOString(),
    actionReference: row.id,
    ask: row.tool,
    summary: row.summary,
    lines: row.lines,
    action: ask.action(ask.input.parse(row.input)),
    status: row.status,
    ...whatItAsksFor(row),
  };
}

/** The app a card offers, or the field and app a card asks a secret for. */
function whatItAsksFor(row: ActionRow): Pick<AskCard, "app" | "field"> {
  if (row.tool === "connect_app") return { app: connectApp.input.parse(row.input).app };
  if (row.tool !== "request_secret") return {};
  const { field, app } = requestSecret.input.parse(row.input);
  return { field, app };
}

/** An ask no card was recorded for; its message says why, for the agent. */
export class AskRefused extends Error {}

/**
 * Records an ask as waiting for the owner's Allow: no gate ever runs one alone. It spends
 * nothing and goes to no venue, so its card is only what it shows. Throws AskRefused for one
 * that may not be asked now (see Ask.blocked).
 */
export async function recordAsk<Tool extends AskToolName>(
  turn: ToolTurn,
  tool: Tool,
  input: AskInput<Tool>,
  shown: { readonly summary: string; readonly lines: readonly ActionLine[] },
): Promise<{ row: ActionRow; card: AskCard }> {
  const ask = ASKS[tool] as Ask<AskInput<Tool>>;
  const parsed = ask.input.parse(input);
  const row = await db.transaction(async (tx) => {
    await lockCards(tx);
    const blocked = await ask.blocked?.(tx, parsed);
    if (blocked) throw new AskRefused(blocked);
    const [recorded] = await tx
      .insert(actions)
      .values({
        threadId: turn.threadId,
        summary: shown.summary,
        amountUsd: "0",
        ...begins("awaiting_permission"),
        venue: null,
        tool,
        input: parsed as Record<string, unknown>,
        lines: [...shown.lines],
      })
      .returning();
    return recorded;
  });
  if (!row) throw new Error("Failed to record the card.");
  return { row, card: askCard(row) };
}

/**
 * Applies an allowed ask inside the transaction that allows it and settles its row: done, or
 * failed with why it couldn't apply (the state changed since the card was shown).
 */
export async function applyAsk(tx: Tx, row: ActionRow): Promise<ActionRow> {
  if (!isAsk(row.tool)) throw new Error(`${row.tool} is not an ask.`);
  const ask = ASKS[row.tool] as Ask<unknown>;
  const refused = await ask.apply(tx, row, ask.input.parse(row.input));
  const [settled] = await step(tx, refused ? "skip" : "apply", eq(actions.id, row.id), {
    error: refused,
    failureKind: refused ? "rule" : null,
  });
  return settled!;
}
