import { execFile } from "node:child_process";

import { AUNI_REPO, ASK_TOOL_NAMES } from "@auni/shared";
import { and, eq, isNull, notInArray } from "drizzle-orm";

import { db } from "./db/client.ts";
import { actions, owner } from "./db/schema.ts";

// The web's ask for a star on Auni's GitHub. It asks once a move of the owner's has landed, and
// never again once they answer, on any device. To see whether they starred Auni already, and to
// star it for them, core runs the owner's own GitHub CLI if they have one: it runs the CLI and
// reads nothing of its login. This is core's alone: the agent has no tool for it, and its box
// can't reach it.

const STARRED = `user/starred/${AUNI_REPO}`;

/** Runs `gh api` on github.com: whether it answered 2xx, and what it said on stderr. */
function gh(args: readonly string[]): Promise<{ readonly ok: boolean; readonly said: string }> {
  return new Promise((resolve) =>
    execFile(
      "gh",
      ["api", "--hostname", "github.com", ...args],
      { timeout: 8_000 },
      (error, _stdout, stderr) => resolve({ ok: !error, said: String(stderr) }),
    ),
  );
}

/**
 * Whether the owner's GitHub account starred Auni. Null when gh can't say: not installed, not
 * signed in, offline, or any answer but GitHub's 204 (starred) or 404 (not).
 */
export async function starredOnGitHub(): Promise<boolean | null> {
  const { ok, said } = await gh([STARRED]);
  if (ok) return true;
  return said.includes("(HTTP 404)") ? false : null;
}

/** Stars Auni as the owner's GitHub account: false when gh couldn't, for any reason. */
export async function starOnGitHub(): Promise<boolean> {
  return (await gh(["-X", "PUT", STARRED])).ok;
}

/** Whether a move of the owner's has landed: a money card done, not an ask. */
export async function aMoveLanded(): Promise<boolean> {
  const [landed] = await db
    .select({ id: actions.id })
    .from(actions)
    .where(and(eq(actions.status, "done"), notInArray(actions.tool, [...ASK_TOOL_NAMES])))
    .limit(1);
  return landed !== undefined;
}

/** Records that the owner answered the ask, the first time only. */
export async function answerStarPrompt(): Promise<void> {
  await db
    .update(owner)
    .set({ starPromptAnsweredAt: new Date() })
    .where(isNull(owner.starPromptAnsweredAt));
}
