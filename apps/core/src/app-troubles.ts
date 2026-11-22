import { and, eq, inArray, sql } from "drizzle-orm";

import { causeOf, defineTool, failure, type AuniTool } from "./agent/tool.ts";
import { OutOfCredits } from "./apps/contract.ts";
import { db } from "./db/client.ts";
import { appTroubles } from "./db/schema.ts";
import { errorWords } from "./safe-words.ts";

/**
 * What keeps going wrong for an app while Auni runs: a key out of credits, or a piece of work
 * that fails each time it is tried (a service that retired the address Auni reads). Core notes
 * it where it runs an app's work (the sweep, a lookup, a watch), keeps it from the first failure
 * until that work goes right again, and says it where the owner looks: the app's sheet
 * (app-list.ts) and `auni doctor`. The log says it once as it starts and once as it ends,
 * rather than a stack trace every time it is tried.
 */

export type Trouble = typeof appTroubles.$inferSelect;

/** Who an app is, as a trouble names it. */
interface Named {
  readonly id: string;
  readonly name: string;
}

/** How long a line of what a service said may be, on a sheet or in doctor. */
const SAID_CHARS = 240;

/** What `error` says, as the owner may read it: its first line, links cut and secrets taken out. */
function saidOf(error: unknown): string {
  const words = errorWords(error).split("\n")[0]!.trim();
  return words.length > SAID_CHARS ? `${words.slice(0, SAID_CHARS - 1)}…` : words;
}

/** Where a key out of credits is kept: one row an app, whichever of its work found it. */
const CREDITS = "spending its credits";

/**
 * Notes that `work` failed for `app`. A key out of credits is the app's, whatever work found it;
 * any other failure is that work's. The log hears of it as it starts, or when what it says
 * changes.
 */
export async function noteTrouble(app: Named, work: string, error: unknown): Promise<void> {
  const kind = error instanceof OutOfCredits ? "credits" : "failing";
  const at = { app: app.id, work: kind === "credits" ? CREDITS : work };
  const said = saidOf(error);
  const [before] = await db
    .select({ said: appTroubles.said })
    .from(appTroubles)
    .where(and(eq(appTroubles.app, at.app), eq(appTroubles.work, at.work)));
  await db
    .insert(appTroubles)
    .values({ ...at, kind, said })
    .onConflictDoUpdate({
      target: [appTroubles.app, appTroubles.work],
      set: { said, lastAt: sql`now()`, times: sql`${appTroubles.times} + 1` },
    });
  if (before?.said !== said) console.error(`${app.name}: ${work} failed:`, error);
}

/** Notes that `work` went right for `app`, which ends its trouble, and shows the app has credits. */
export async function clearTrouble(app: Named, work: string): Promise<void> {
  const ended = await db
    .delete(appTroubles)
    .where(and(eq(appTroubles.app, app.id), inArray(appTroubles.work, [work, CREDITS])))
    .returning({ work: appTroubles.work });
  for (const { work: was } of ended)
    console.info(
      `${app.name}: ${was === CREDITS ? "its credits are back" : `${was} works again`}.`,
    );
}

/** Runs `work` for `app`, noting whether it went right (see above), and hands on what it gave or threw. */
export async function attempt<T>(app: Named, work: string, run: () => Promise<T>): Promise<T> {
  let done: T;
  try {
    done = await run();
  } catch (error) {
    await noteTrouble(app, work, error);
    throw error;
  }
  await clearTrouble(app, work);
  return done;
}

/**
 * An app's lookup as the agent calls it. One that finds the app's key out of credits notes it on
 * the app, and tells the agent to say so to the owner rather than quietly look elsewhere; any
 * answer ends it. Any other refusal is the lookup's own (a name it doesn't know), so notes nothing.
 */
export function watchedLookup(app: Named, tool: AuniTool): AuniTool {
  return defineTool({
    ...tool,
    async handler(input) {
      const answer = await tool.handler(input);
      const cause = causeOf(answer);
      if (cause instanceof OutOfCredits) {
        await noteTrouble(app, `answering ${tool.name}`, cause);
        return failure(
          new Error(
            `${app.name} is out of credits, so it answered nothing. Tell the owner in your reply, plainly and before anything you find elsewhere: ${app.name} can't be used until its account is topped up, which its sheet in Apps says too. If you answer from other sources instead, say which.`,
          ),
        );
      }
      if (!answer.isError) await clearTrouble(app, `answering ${tool.name}`);
      return answer;
    },
  });
}

/** Every trouble standing now, the oldest first. */
export function appTroublesNow(): Promise<Trouble[]> {
  return db.select().from(appTroubles).orderBy(appTroubles.since);
}

/**
 * A trouble as the owner reads it, given `when` says a moment in their own time: what is wrong
 * in a few words, then the whole of it. Out of credits stops everything the app does for Auni;
 * a failing piece of work is only that work.
 */
export function troubleWords(
  { kind, work, said, since, lastAt, times }: Trouble,
  name: string,
  when: (at: Date) => string,
): { readonly short: string; readonly says: string } {
  if (kind === "credits")
    return {
      short: "Out of credits",
      says: `${name} said its account is out of credits when Auni last asked it, at ${when(lastAt)}. Auni can't use ${name} until the account is topped up, and starts again by itself once it is.`,
    };
  const tried = times === 1 ? `at ${when(since)}` : `${times} times since ${when(since)}`;
  return {
    short: "Not working",
    says: `${work[0]!.toUpperCase()}${work.slice(1)} failed ${tried}: ${said}`,
  };
}
